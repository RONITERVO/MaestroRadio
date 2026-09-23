package com.ronit.maestroradio

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class PlannerTest {
    private fun templates() = JSONObject(File("src/main/assets/prompts.json").readText())
    private fun response(index: Int): JSONObject {
        val plan = JSONObject().put("angle", "Development $index").put("newFacts", JSONArray().put("New fact $index"))
            .put("nextThread", "Follow the next consequence.").put("pairs", JSONArray().put(JSONObject().put("target", "Una frase $index.").put("native", "Sentence $index.")))
        val content = textContent("model", plan.toString())
        content.getJSONArray("parts").getJSONObject(0).put("thoughtSignature", "signature-$index")
        return JSONObject().put("candidates", JSONArray().put(JSONObject().put("content", content)))
    }
    @Test fun `fallback keeps the complete history and provider signatures`() = runBlocking {
        val counted = mutableListOf<JSONObject>(); val generated = mutableListOf<JSONObject>(); var index = 0
        val api = object : GeminiApi() {
            override suspend fun rest(key: String, path: String, body: JSONObject?): JSONObject {
                if (!path.contains(':')) return JSONObject().put("inputTokenLimit", 1048576)
                if (path.endsWith(":countTokens")) { counted.add(JSONObject(body!!.getJSONObject("generateContentRequest").toString())); return JSONObject().put("totalTokens", 4000) }
                if (path.contains("gemini-2.5-flash:")) throw ProviderFailure(429, 60000, true)
                generated.add(JSONObject(body!!.toString())); return response(++index)
            }
        }
        val file = File.createTempFile("radio-memory", ".json")
        try {
            val planner = Planner(api, KeyRouter(listOf("one")), RadioSettings(topic = "An unfolding story"), templates(), file) { _, _, _ -> }
            planner.next(); planner.observe("ACTUAL_SPOKEN_RECEIPT"); planner.next()
            assertEquals(2, generated.size)
            assertTrue(generated.last().toString().contains("signature-1"))
            assertTrue(generated.last().toString().contains("ACTUAL_SPOKEN_RECEIPT"))
            assertEquals(counted.last().getJSONArray("contents").toString(), generated.last().getJSONArray("contents").toString())
            assertTrue(generated.last().getString("model").contains("gemini-3-flash-preview"))
            assertTrue(file.readText().contains("ACTUAL_SPOKEN_RECEIPT"))
        } finally { file.delete(); api.close() }
    }
    @Test fun `full context stops before generation without trimming the ledger`() = runBlocking {
        var generated = false
        val api = object : GeminiApi() {
            override suspend fun rest(key: String, path: String, body: JSONObject?): JSONObject {
                if (!path.contains(':')) return JSONObject().put("inputTokenLimit", 10000)
                if (path.endsWith(":countTokens")) return JSONObject().put("totalTokens", 9000)
                generated = true; return response(1)
            }
        }
        val file = File.createTempFile("radio-memory", ".json")
        try {
            val planner = Planner(api, KeyRouter(listOf("one")), RadioSettings(), templates(), file) { _, _, _ -> }
            planner.observe("KEEP_ALL_HISTORY")
            try { planner.next(); fail("Expected context limit") } catch (_: MemoryFull) {}
            planner.save(); assertFalse(generated); assertTrue(file.readText().contains("KEEP_ALL_HISTORY"))
        } finally { file.delete(); api.close() }
    }
}
