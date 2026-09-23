package com.ronit.maestroradio

import android.util.Base64
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.random.Random

const val LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
data class VoiceTurn(val pcm: ByteArray, val cues: List<Caption>, val transcript: String, val coverage: Double)
class LiveVoice(private val api: GeminiApi, private val keys: KeyRouter, private val voice: String, private val template: String,
                private val targetCode: String, private val nativeCode: String, private val record: (JSONObject) -> Unit) {
    suspend fun narrate(lines: List<SpokenLine>): VoiceTurn {
        repeat(3) { attempt ->
            val result = keys.run(LIVE_MODEL) { key -> generate(key, lines, attempt) }
            if (result.coverage >= .82 && result.cues.isNotEmpty()) return result
        }
        throw RadioFailure("The narrator missed part of the translation three times. Incomplete audio was not played.")
    }
    private suspend fun generate(key: String, lines: List<SpokenLine>, attempt: Int): VoiceTurn = withTimeout(60000) {
        val socket = api.socket(key)
        try {
            val text = lines.joinToString("\n\n") { (if (attempt == 2) "[${if (it.target) targetCode else nativeCode}] " else "") + (if (attempt > 0) stripTags(it.text) else it.text) }
            socket.send(JSONObject().put("setup", JSONObject().put("model", "models/$LIVE_MODEL")
                .put("generationConfig", JSONObject().put("responseModalities", JSONArray().put("AUDIO")).put("seed", Random.nextInt(Int.MAX_VALUE))
                    .put("thinkingConfig", JSONObject().put("thinkingBudget", 0))
                    .put("speechConfig", JSONObject().put("voiceConfig", JSONObject().put("prebuiltVoiceConfig", JSONObject().put("voiceName", voice)))))
                .put("outputAudioTranscription", JSONObject())
                .put("systemInstruction", JSONObject().put("parts", JSONArray().put(JSONObject().put("text", template.replace("__TEXT__", text)))))))
            while (!socket.messages.receive().has("setupComplete")) { /* Wait for provider handshake. */ }
            socket.send(JSONObject().put("clientContent", JSONObject().put("turns", JSONArray().put(textContent("user", "Play"))).put("turnComplete", true)))
            val bytes = ByteArrayOutputStream()
            val clock = TranscriptClock(lines)
            while (true) {
                val message = socket.messages.receive()
                val content = message.optJSONObject("serverContent") ?: continue
                if (content.optBoolean("interrupted")) throw RadioFailure("Voice turn was interrupted.")
                for (part in content.optJSONObject("modelTurn")?.objects("parts") ?: emptyList()) {
                    val data = part.optJSONObject("inlineData") ?: continue
                    val mime = data.optString("mimeType")
                    if (!mime.startsWith("audio/pcm") || (mime.contains("rate=") && !mime.contains("rate=24000"))) throw RadioFailure("Unsupported narration format.")
                    val pcm = Base64.decode(data.getString("data"), Base64.DEFAULT)
                    if (pcm.size % 2 != 0 || bytes.size() + pcm.size > 48000 * 100) throw RadioFailure("Invalid narration audio length.")
                    bytes.write(pcm); clock.audio(bytes.size() / 2L)
                }
                content.optJSONObject("outputTranscription")?.optString("text")?.takeIf { it.isNotEmpty() }?.let { clock.add(it, bytes.size() / 2L) }
                if (content.optBoolean("generationComplete") || content.optBoolean("turnComplete")) break
            }
            clock.finish(bytes.size() / 2L)
            val coverage = if (clock.lineCoverage.any { it < .55 }) 0.0 else clock.coverage
            record(JSONObject().put("type", "voiceAttempt").put("attempt", attempt).put("expected", JSONArray(lines.map { it.text }))
                .put("transcript", clock.raw).put("coverage", clock.coverage).put("lineCoverage", JSONArray(clock.lineCoverage)))
            if (bytes.size() == 0 || clock.raw.isBlank()) throw RadioFailure("The narrator returned no spoken audio or transcript.")
            VoiceTurn(bytes.toByteArray(), clock.cues.toList(), clock.raw, coverage)
        } finally { socket.close() }
    }
}
