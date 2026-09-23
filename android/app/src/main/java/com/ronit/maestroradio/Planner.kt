package com.ronit.maestroradio

import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class SpokenLine(val text: String, val target: Boolean)
data class Passage(val raw: JSONObject, val lines: List<SpokenLine>)
class Planner(private val api: GeminiApi, private val keys: KeyRouter, settings: RadioSettings,
              templates: JSONObject, private val archive: File, private val context: (String, Int, Int) -> Unit) {
    private val models = listOf("gemini-2.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash-lite")
    private var model = models.first()
    private val limits = mutableMapOf<String, Int>()
    private val history = JSONArray()
    private val facts = mutableSetOf<String>()
    private val sentences = mutableSetOf<String>()
    private var count = 0
    private val expressive = settings.expressive
    private val target = LANGUAGES[settings.target]
    private val native = LANGUAGES[settings.native]
    private val system = templates.getString("writer_${settings.style.isNotBlank()}_${settings.expressive}")
        .replace("__TARGET_NAME__", target.name).replace("__TARGET_CODE__", target.code)
        .replace("__NATIVE_NAME__", native.name).replace("__NATIVE_CODE__", native.code).replace("__LEVEL__", settings.level)
        .replace("\"__TOPIC__\"", JSONObject.quote(settings.topic)).replace("\"__STYLE__\"", JSONObject.quote(settings.style))
    private val schema = JSONObject("""{"type":"object","properties":{"angle":{"type":"string"},"newFacts":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":6},"nextThread":{"type":"string"},"pairs":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","properties":{"target":{"type":"string"},"native":{"type":"string"}},"required":["target","native"]}}},"required":["angle","newFacts","nextThread","pairs"]}""").apply {
        getJSONObject("properties").getJSONObject("pairs").getJSONObject("items").getJSONObject("properties").apply {
            getJSONObject("target").put("description", "Sentence in ${target.name}, spoken FIRST.")
            getJSONObject("native").put("description", "Faithful translation in ${native.name}, spoken SECOND.")
        }
    }
    @Synchronized fun observe(text: String) { history.put(textContent("user", text)) }
    @Synchronized fun save() { archive.writeText(JSONObject().put("model", model).put("system", system).put("history", history).toString()) }
    @Synchronized private fun snapshot() = JSONArray(history.toString())
    @Synchronized private fun record(content: JSONObject) { history.put(content) }
    suspend fun next(): Passage {
        observe(if (count == 0) "Begin directly with a concise first sentence of about 8–12 words and its faithful translation. Develop that thought in the remaining pairs."
            else "Continue directly after the last planned sentence. Develop something new using the COMPLETE ledger. The previous passage may still be playing.")
        repeat(3) {
            val contents = snapshot()
            val response = generate(contents)
            val content = response.optJSONArray("candidates")?.optJSONObject(0)?.optJSONObject("content") ?: throw RadioFailure("The writer returned no passage.")
            record(content) // Preserve thought signatures and rejected drafts verbatim.
            val text = content.objects("parts").filter { !it.optBoolean("thought") }.joinToString("") { it.optString("text") }
            val plan = runCatching { JSONObject(text) }.getOrNull()
            val pairs = plan?.objects("pairs") ?: emptyList()
            val lines = pairs.flatMap { listOf(SpokenLine(it.optString("target"), true), SpokenLine(it.optString("native"), false)) }
            val newFacts = plan?.optJSONArray("newFacts")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
            val proposed = pairs.map { fingerprint(it.optString("target")) }
            val repeated = proposed.any { sentence -> sentence in sentences || sentences.any { old ->
                val words = sentence.split(' ').toSet(); val previous = old.split(' ').toSet()
                words.size > 7 && words.intersect(previous).size.toDouble() / words.union(previous).size > .85
            } } || proposed.distinct().size != proposed.size || newFacts.any { fingerprint(it) in facts }
            if (plan != null && pairs.size in 1..4 && newFacts.isNotEmpty() && newFacts.size <= 6 &&
                lines.all { it.text.isNotBlank() && it.text.length <= (if (it.target) 300 else 400) } && !repeated &&
                lines.none { unknownTags(it.text) || (!expressive && stripTags(it.text) != it.text) } && plan.optString("nextThread").isNotBlank()) {
                sentences.addAll(proposed); facts.addAll(newFacts.map(::fingerprint)); count++; save()
                return Passage(plan, lines)
            }
            observe("This draft was NOT narrated. Repair: return valid JSON with 1–4 complete sentence/translation pairs; remove unknown bracketed tags, repeated facts, and repeated sentences. Continue in ${target.name} then ${native.name}.")
        }
        throw RadioFailure("The writer repeated itself or returned invalid passages three times. The full history is saved.")
    }
    private suspend fun generate(contents: JSONArray): JSONObject {
        var failure: Throwable = ProviderFailure(503)
        for (candidate in listOf(model) + models.filter { it != model }) {
            currentCoroutineContext().ensureActive()
            try {
                val result = withTimeout(12000) {
                    keys.run(candidate) { key ->
                        val limit = limits[candidate] ?: api.rest(key, "models/$candidate").getInt("inputTokenLimit").coerceAtMost(1048576).also { limits[candidate] = it }
                        val request = JSONObject().put("model", "models/$candidate").put("contents", contents)
                            .put("systemInstruction", JSONObject().put("parts", JSONArray().put(JSONObject().put("text", system))))
                        val used = api.rest(key, "models/$candidate:countTokens", JSONObject().put("generateContentRequest", request)).getInt("totalTokens")
                        context(candidate, used, limit)
                        if (used + 8192 >= limit) throw MemoryFull()
                        val thinking = if (candidate.startsWith("gemini-2.5")) JSONObject().put("thinkingBudget", 0) else JSONObject().put("thinkingLevel", "MINIMAL")
                        request.put("generationConfig", JSONObject().put("temperature", .8).put("maxOutputTokens", 2048).put("responseMimeType", "application/json")
                            .put("responseJsonSchema", schema).put("thinkingConfig", thinking))
                        api.rest(key, "models/$candidate:generateContent", request)
                    }
                }
                model = candidate
                return result
            } catch (e: TimeoutCancellationException) { currentCoroutineContext().ensureActive(); failure = e }
            catch (e: ProviderFailure) { if (e.status == 400) throw e; failure = e }
        }
        throw failure
    }
}
