package com.ronit.maestroradio

import android.content.Context
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class DisplayLine(val id: Int, val target: Boolean, val text: String)
data class RadioView(val active: Boolean = false, val paused: Boolean = false, val status: String = "Ready", val error: String = "",
    val music: String = "", val writer: String = "gemini-2.5-flash", val used: Int = 0, val limit: Int = 1048576,
    val speed: Float = 1f, val elapsed: Long = 0, val lines: List<DisplayLine> = emptyList())
object RadioState { val view = MutableStateFlow(RadioView()); var engine: RadioEngine? = null }
class RadioEngine(context: Context, private val settings: RadioSettings, keys: List<String>, private val finished: () -> Unit) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val api = GeminiApi()
    private val router = KeyRouter(keys)
    private val folder = File(context.filesDir, "episodes/${UUID.randomUUID()}").apply { mkdirs() }
    private val latest = File(context.filesDir, "latest.json")
    private val templates = JSONObject(context.assets.open("prompts.json").bufferedReader().use { it.readText() })
    private val captions = ArrayDeque<Caption>()
    private val heard = linkedMapOf<Int, DisplayLine>()
    private var captionChars = 0
    private var turns = 0
    private var firstVoiceMs = 0L
    private var gapStarted = 0L
    private var gaps = 0
    private var maxGapMs = 0L
    private val started = System.currentTimeMillis()
    private var draining = false
    private var memoryFull = false
    private val player = NativePlayer(scope, settings.speed, settings.musicVolume, { error ->
        RadioState.view.update { it.copy(music = "Music unavailable. ${safeMessage(error)} Speech continues.") }
    }) { error ->
        RadioState.view.update { it.copy(error = safeMessage(error)) }; stop()
    }
    private val planner = Planner(api, router, settings, templates, File(folder, "memory.json")) { model, used, limit ->
        RadioState.view.update { it.copy(writer = model, used = used, limit = limit) }
    }
    private var task: Job? = null
    init { File(folder, "episode.json").writeText(settings.json().toString()) }
    fun start() {
        RadioState.view.value = RadioView(active = true, status = "Following a thought", speed = settings.speed)
        task = scope.launch {
            val ticker = launch { tick() }
            val music = if (settings.music) launch { Lyria(api, router, player, settings.musicPrompt) { message -> RadioState.view.update { it.copy(music = message) } }.run() } else null
            var reason = "Episode ended"
            try { pipeline(); draining = true; drain(); reason = if (memoryFull) "Memory complete" else "Episode ended" }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                RadioState.view.update { it.copy(error = safeMessage(error), status = "Stream issue") }
                draining = true; drain()
            } finally {
                withContext(NonCancellable) {
                    music?.cancelAndJoin(); ticker.cancelAndJoin(); planner.save(); saveHeard()
                    RadioState.view.update { it.copy(active = false, paused = false, status = reason) }
                    diagnostics(); player.close(); api.close()
                    withContext(Dispatchers.Main) { finished() }
                }
                scope.cancel()
            }
        }
    }
    private suspend fun pipeline() = coroutineScope {
        val plans = Channel<Passage>(1)
        val writer = launch {
            try {
                while (isActive) {
                    runway(); plans.send(planner.next())
                }
            } catch (_: MemoryFull) { memoryFull = true; plans.close() }
            catch (error: Exception) { plans.close(error) }
            finally { plans.close() }
        }
        val voice = LiveVoice(api, router, settings.voice, templates.getString("voice"), LANGUAGES[settings.target].code, LANGUAGES[settings.native].code) { event ->
            synchronized(folder) { File(folder, "voice-attempts.jsonl").appendText(event.toString() + "\n") }
        }
        val pending = ArrayDeque<Deferred<VoiceTurn>>()
        suspend fun publish() {
            val turn = pending.removeFirst().await()
            val id = turns++ * 10
            val start = player.enqueueVoice(turn.pcm)
            synchronized(captions) { turn.cues.forEach { captions.addLast(it.copy(line = id + it.line, start = start + it.start, end = start + it.end)) } }
            planner.observe("Narration receipt: ${JSONObject.quote(turn.transcript)}. Complete generated audio; may still be buffered.")
            File(folder, "ledger.jsonl").appendText(JSONObject().put("type", "voice").put("turn", turns).put("samples", turn.pcm.size / 2).put("coverage", turn.coverage).put("transcript", turn.transcript).toString() + "\n")
        }
        try {
            var opening = true
            for (plan in plans) {
                File(folder, "ledger.jsonl").appendText(JSONObject().put("type", "plan").put("plan", plan.raw).toString() + "\n")
                var index = 0
                while (index < plan.lines.size) {
                    if (pending.size >= 2) publish()
                    runway()
                    val count = if (opening && index < 4) 2 else 4
                    val batch = plan.lines.subList(index, minOf(index + count, plan.lines.size)).toList()
                    pending.addLast(async { voice.narrate(batch) }); index += count
                    if (pending.size == 2) publish()
                }
                opening = false
            }
            while (pending.isNotEmpty()) publish()
        } finally { writer.cancelAndJoin(); pending.forEach { it.cancel() }; plans.cancel() }
    }
    private suspend fun runway() { while (player.paused || player.queuedVoiceSamples > (24000 * 45 * player.speed).toLong()) delay(100) }
    private suspend fun drain() { while (player.queuedVoiceSamples > 0) delay(100) }
    private suspend fun tick() {
        var lastSave = 0L
        while (currentCoroutineContext().isActive) {
            val sample = player.playedSamples
            if (sample > 0 && firstVoiceMs == 0L) firstVoiceMs = System.currentTimeMillis() - started
            var changed = false
            synchronized(captions) {
                while (captions.isNotEmpty()) {
                    val cue = captions.first()
                    if (sample < cue.start) break
                    val points = cue.text.codePoints().toArray()
                    val fraction = if (cue.end <= cue.start) 1.0 else ((sample - cue.start).toDouble() / (cue.end - cue.start)).coerceIn(0.0, 1.0)
                    val count = (points.size * fraction).toInt()
                    if (count > captionChars) {
                        val text = String(points, captionChars, count - captionChars)
                        val old = heard[cue.line]
                        if (old != null || text.isNotBlank()) heard[cue.line] = DisplayLine(cue.line, cue.target, (old?.text ?: "") + text)
                        captionChars = count; changed = true
                    }
                    if (fraction < 1) break
                    captions.removeFirst(); captionChars = 0
                }
            }
            val now = System.currentTimeMillis()
            if (!draining && !player.paused && sample > 0 && player.queuedVoiceSamples == 0L) {
                if (gapStarted == 0L) gapStarted = now
            } else if (gapStarted != 0L) {
                val gap = now - gapStarted; if (gap > 250) { gaps++; maxGapMs = maxOf(maxGapMs, gap) }; gapStarted = 0
            }
            RadioState.view.update { it.copy(elapsed = sample / 24000, lines = if (changed) heard.values.toList().takeLast(120) else it.lines,
                status = if (player.paused) "Paused" else if (sample > 0 && it.error.isEmpty()) "On air" else it.status) }
            if (now - lastSave > 1000) { diagnostics(); lastSave = now }
            delay(30)
        }
    }
    private fun diagnostics() {
        latest.writeText(JSONObject().put("episode", folder.name).put("active", RadioState.view.value.active).put("turns", turns)
            .put("playedSamples", player.playedSamples).put("queuedVoiceSamples", player.queuedVoiceSamples).put("firstVoiceMs", firstVoiceMs)
            .put("musicBufferedSeconds", player.musicBufferedSeconds).put("peakBufferedMusicSeconds", player.peakBufferedMusic)
            .put("speed", player.speed.toDouble()).put("paused", player.paused).put("gaps", gaps).put("maxGapMs", maxGapMs)
            .put("music", RadioState.view.value.music).put("error", RadioState.view.value.error).toString())
    }
    private fun saveHeard() { File(folder, "heard.txt").writeText(heard.values.joinToString("\n\n") { it.text.trim() }) }
    fun transcript() = synchronized(captions) { heard.values.joinToString("\n\n") { it.text.trim() } }
    fun pause(value: Boolean) { player.pause(value); RadioState.view.update { it.copy(paused = value, status = if (value) "Paused" else "On air") } }
    fun speed(value: Float) { player.setSpeed(value); RadioState.view.update { it.copy(speed = value) } }
    fun volume(value: Float) { player.musicVolume = value.coerceIn(0f, 1f) }
    fun stop() { task?.cancel() }
}
