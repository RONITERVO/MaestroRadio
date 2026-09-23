package com.ronit.maestroradio

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class ProviderFailure(val status: Int, val cooldownMs: Long = 0, val daily: Boolean = false) : Exception("Gemini request failed ($status)")
class RadioFailure(message: String) : Exception(message)
class MemoryFull : Exception("Episode memory is full. Start a new episode.")
fun safeMessage(error: Throwable): String = when (error) {
    is ProviderFailure -> when(error.status) { 429 -> "All available keys are cooling down or out of quota. Add another project key or try later."; 401,403,404 -> "No configured key has access to this model."; else -> "Gemini connection failed (${error.status}). Try again." }
    is RadioFailure, is MemoryFull -> error.message ?: "Episode ended."
    is TimeoutCancellationException -> "The model did not respond in time. Try another episode."
    else -> "Connection interrupted. Check your network and try again."
}
fun statusFrom(reason: String): Int = Regex("\\b(400|401|403|404|429|500|502|503|504)\\b").find(reason)?.value?.toInt()
    ?: when { reason.contains("RESOURCE_EXHAUSTED", true) || reason.contains("quota", true) -> 429; reason.contains("not found", true) -> 404; reason.contains("permission", true) -> 403; else -> 503 }
class KeyRouter(private val keys: List<String>) {
    private data class Health(var until: Long = 0, var disabled: Boolean = false, var inFlight: Int = 0)
    private val health = mutableMapOf<String, Array<Health>>()
    private var cursor = 0
    suspend fun <T> run(model: String, operation: suspend (String) -> T): T {
        val tried = mutableSetOf<Int>()
        var last: Exception = ProviderFailure(429)
        while (tried.size < keys.size) {
            currentCoroutineContext().ensureActive()
            val index = synchronized(this) {
                val states = health.getOrPut(model) { Array(keys.size) { Health() } }
                val ready = keys.indices.filter { !tried.contains(it) && !states[it].disabled && states[it].until <= System.currentTimeMillis() }
                ready.minWithOrNull(compareBy<Int> { states[it].inFlight }.thenBy { (it - cursor + keys.size) % keys.size })?.also {
                    states[it].inFlight++; cursor = (it + 1) % keys.size
                }
            } ?: throw last
            tried.add(index)
            try { return operation(keys[index]) }
            catch (e: ProviderFailure) {
                last = e
                synchronized(this) {
                    val state = health.getValue(model)[index]
                    if (e.status in listOf(401, 403, 404)) state.disabled = true
                    else if (e.status == 429 || e.status >= 500) {
                        val reset = if (e.daily) ZonedDateTime.now(ZoneId.of("America/Los_Angeles")).toLocalDate().plusDays(1).atStartOfDay(ZoneId.of("America/Los_Angeles")).toInstant().toEpochMilli() else 0
                        state.until = maxOf(state.until, reset, System.currentTimeMillis() + maxOf(e.cooldownMs, if (e.status == 429) 15000 else 1000))
                    } else throw e
                }
            } finally { synchronized(this) { health.getValue(model)[index].inFlight-- } }
        }
        throw last
    }
}
open class GeminiApi {
    private val client = OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build()
    private val liveClient = client.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).callTimeout(0, TimeUnit.MILLISECONDS).pingInterval(20, TimeUnit.SECONDS).build()
    open suspend fun rest(key: String, path: String, body: JSONObject? = null): JSONObject = suspendCancellableCoroutine { cont ->
        val request = Request.Builder().url("https://generativelanguage.googleapis.com/v1beta/$path").header("x-goog-api-key", key)
        if (body != null) request.post(body.toString().toRequestBody("application/json".toMediaType()))
        val call = client.newCall(request.build())
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(ProviderFailure(503)) }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    try {
                        val raw = response.body?.string() ?: "{}"
                        if (!response.isSuccessful) {
                            val retry = Regex("\"retryDelay\"\\s*:\\s*\"([0-9.]+)s\"").find(raw)?.groupValues?.get(1)?.toDoubleOrNull()?.times(1000)?.toLong() ?: 0
                            throw ProviderFailure(response.code, retry, raw.contains("PerDay", true) || raw.contains("per_day", true))
                        }
                        val json = JSONObject(raw)
                        if (cont.isActive) cont.resume(json)
                    } catch (error: Exception) { if (cont.isActive) cont.resumeWithException(error) }
                }
            }
        })
    }
    fun socket(key: String, music: Boolean = false): GeminiSocket {
        val socket = GeminiSocket()
        val method = if (music) "BidiGenerateMusic" else "BidiGenerateContent"
        socket.ws = liveClient.newWebSocket(Request.Builder().url("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.$method")
            .header("x-goog-api-key", key).build(), socket)
        return socket
    }
    fun close() { client.dispatcher.cancelAll(); liveClient.dispatcher.cancelAll(); client.connectionPool.evictAll(); liveClient.connectionPool.evictAll() }
}
class GeminiSocket : WebSocketListener() {
    lateinit var ws: WebSocket
    val opened = CompletableDeferred<Unit>()
    val messages = Channel<JSONObject>(128)
    override fun onOpen(webSocket: WebSocket, response: Response) { opened.complete(Unit) }
    override fun onMessage(webSocket: WebSocket, text: String) { receive(text) }
    override fun onMessage(webSocket: WebSocket, bytes: ByteString) { receive(bytes.utf8()) }
    private fun receive(text: String) {
        try {
            val value = JSONObject(text)
            if (value.has("error")) { fail(ProviderFailure(value.getJSONObject("error").optInt("code", 503))); return }
            if (messages.trySend(value).isFailure) { fail(RadioFailure("The audio connection sent data faster than playback could buffer.")); ws.cancel() }
        } catch (_: Exception) { fail(RadioFailure("Invalid provider stream.")); ws.cancel() }
    }
    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { fail(ProviderFailure(response?.code ?: 503)) }
    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { fail(ProviderFailure(statusFrom(reason))) }
    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null); fail(ProviderFailure(statusFrom(reason))) }
    private fun fail(error: Exception) { opened.completeExceptionally(error); messages.close(error) }
    suspend fun send(value: JSONObject) { opened.await(); if (!ws.send(value.toString())) throw ProviderFailure(503) }
    fun close() { ws.cancel(); messages.cancel(); opened.cancel() }
}
fun textContent(role: String, text: String) = JSONObject().put("role", role).put("parts", JSONArray().put(JSONObject().put("text", text)))
fun JSONObject.objects(name: String): List<JSONObject> { val a = optJSONArray(name) ?: return emptyList(); return (0 until a.length()).mapNotNull { a.optJSONObject(it) } }
