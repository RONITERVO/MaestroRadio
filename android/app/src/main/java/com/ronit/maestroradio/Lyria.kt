package com.ronit.maestroradio

import android.util.Base64
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

const val MUSIC_MODEL = "lyria-realtime-exp"
class Lyria(private val api: GeminiApi, private val keys: KeyRouter, private val player: NativePlayer, private val prompt: String, private val status: (String) -> Unit) {
    suspend fun run() {
        status("Connecting to Lyria…")
        try {
            repeat(3) { attempt ->
                try { keys.run(MUSIC_MODEL) { key -> stream(key) }; return }
                catch (error: CancellationException) { throw error }
                catch (error: Exception) { if (attempt == 2 || (error is ProviderFailure && error.status in listOf(400,401,403,404,429))) throw error; delay(1000L * (attempt + 1)) }
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { status("Music unavailable. ${safeMessage(error)} Speech continues.") }
    }
    private suspend fun stream(key: String) = coroutineScope {
        val socket = api.socket(key, true)
        try {
            withTimeout(15000) {
                socket.send(JSONObject().put("setup", JSONObject().put("model", "models/$MUSIC_MODEL")))
                while (!socket.messages.receive().has("setupComplete")) {}
            }
            socket.send(JSONObject().put("clientContent", JSONObject().put("weightedPrompts", JSONArray().put(JSONObject()
                .put("text", "$prompt. Instrumental only, no vocals. Leave room for spoken narration.").put("weight", 1)))))
            socket.send(JSONObject().put("musicGenerationConfig", JSONObject().put("musicGenerationMode", "QUALITY").put("temperature", 1).put("guidance", 4.5).put("density", .3).put("brightness", .4)))
            socket.send(JSONObject().put("playbackControl", "PLAY"))
            var providerPaused = false
            var lastAudio = System.currentTimeMillis()
            val flow = launch {
                while (isActive) {
                    val pause = player.paused || player.musicBufferedSeconds > 8 || (providerPaused && player.musicBufferedSeconds > 3)
                    if (pause != providerPaused) { socket.send(JSONObject().put("playbackControl", if (pause) "PAUSE" else "PLAY")); providerPaused = pause }
                    if (pause) lastAudio = System.currentTimeMillis()
                    else if (System.currentTimeMillis() - lastAudio > 30000) throw ProviderFailure(503)
                    delay(200)
                }
            }
            try {
                for (message in socket.messages) {
                    if (message.has("filteredPrompt")) throw RadioFailure("Try a different instrumental music description.")
                    for (chunk in message.optJSONObject("serverContent")?.objects("audioChunks") ?: emptyList()) {
                        val mime = chunk.optString("mimeType", "audio/l16;rate=48000;channels=2")
                        if (!mime.startsWith("audio/l16") && !mime.startsWith("audio/pcm")) throw RadioFailure("Unsupported music format.")
                        val rate = Regex("rate=(\\d+)").find(mime)?.groupValues?.get(1)?.toInt() ?: 48000
                        val channels = Regex("channels=(\\d+)").find(mime)?.groupValues?.get(1)?.toInt() ?: 2
                        val pcm = Base64.decode(chunk.getString("data"), Base64.DEFAULT)
                        if (pcm.size > rate * 4 * 20) throw RadioFailure("Music chunk exceeded its buffer limit.")
                        player.enqueueMusic(pcm, rate, channels); lastAudio = System.currentTimeMillis(); status("Lyria · playing")
                    }
                }
            } finally { flow.cancelAndJoin() }
        } finally { socket.close() }
    }
}
