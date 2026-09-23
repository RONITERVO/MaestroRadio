package com.ronit.maestroradio

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class PlannerTest {
    private fun templates() = JSONObject(File("src/main/assets/prompts.json").readText())
    private fun response(index: Int, music: Any? = null): JSONObject {
        val plan = JSONObject().put("angle", "Development $index").put("newFacts", JSONArray().put("New fact $index"))
            .put("nextThread", "Follow the next consequence.").put("pairs", JSONArray().put(JSONObject().put("target", "Una frase $index.").put("native", "Sentence $index.")))
        if (music != null) plan.put("musicPrompt", music)
        val content = textContent("model", plan.toString())
        content.getJSONArray("parts").getJSONObject(0).put("thoughtSignature", "signature-$index")
        return JSONObject().put("candidates", JSONArray().put(JSONObject().put("content", content)))
    }
    @Test fun `automatic score uses the shared examples once and never enters spoken lines`() = runBlocking {
        val prompt = "Sparse hand-damped harp, low bassoon far back, patient woodland texture. No vocals or recurring hooks; room for a speaking voice."
        val generated = mutableListOf<JSONObject>()
        val api = object : GeminiApi() {
            override suspend fun rest(key: String, path: String, body: JSONObject?): JSONObject {
                if (!path.contains(':')) return JSONObject().put("inputTokenLimit", 1048576)
                if (path.endsWith(":countTokens")) return JSONObject().put("totalTokens", 2000)
                generated.add(JSONObject(body!!.toString())); return response(generated.size, prompt)
            }
        }
        val file = File.createTempFile("music-memory", ".json")
        try {
            val planner = Planner(api, KeyRouter(listOf("one")), RadioSettings(topic = "A fox steals a crown", style = "A comedy folk tale"), templates(), file) { _, _, _ -> }
            val first = planner.next(); val second = planner.next()
            assertEquals(2, generated.size)
            assertEquals(prompt, first.raw.getString("musicPrompt")); assertFalse(second.raw.has("musicPrompt"))
            assertTrue(first.lines.none { it.text.contains("harp") })
            assertTrue(generated.first().getJSONObject("generationConfig").getJSONObject("responseJsonSchema").getJSONArray("required").toString().contains("musicPrompt"))
            assertFalse(generated.last().getJSONObject("generationConfig").getJSONObject("responseJsonSchema").getJSONObject("properties").has("musicPrompt"))
            val system = generated.first().getJSONObject("systemInstruction").toString()
            assertTrue(system.contains("Roman numerals:")); assertTrue(system.contains("A fox steals a crown")); assertTrue(system.contains("A comedy folk tale"))
        } finally { file.delete(); api.close() }
    }
    @Test fun `bad music metadata preserves speech and retries only within three normal passages`() = runBlocking {
        val requested = mutableListOf<Boolean>()
        val api = object : GeminiApi() {
            override suspend fun rest(key: String, path: String, body: JSONObject?): JSONObject {
                if (!path.contains(':')) return JSONObject().put("inputTokenLimit", 1048576)
                if (path.endsWith(":countTokens")) return JSONObject().put("totalTokens", 2000)
                requested.add(body!!.getJSONObject("generationConfig").getJSONObject("responseJsonSchema").getJSONObject("properties").has("musicPrompt"))
                return response(requested.size, 123)
            }
        }
        val file = File.createTempFile("music-memory", ".json")
        try {
            val planner = Planner(api, KeyRouter(listOf("one")), RadioSettings(), templates(), file) { _, _, _ -> }
            repeat(4) { assertFalse(planner.next().raw.has("musicPrompt")) }
            assertEquals(listOf(true, true, true, false), requested)
        } finally { file.delete(); api.close() }
    }
    @Test fun `custom or disabled music never requests an automatic score`() = runBlocking {
        for (settings in listOf(RadioSettings(musicPrompt = "Quiet guitar"), RadioSettings(music = false))) {
            val api = object : GeminiApi() {
                override suspend fun rest(key: String, path: String, body: JSONObject?): JSONObject {
                    if (!path.contains(':')) return JSONObject().put("inputTokenLimit", 1048576)
                    if (path.endsWith(":countTokens")) return JSONObject().put("totalTokens", 2000)
                    assertFalse(body!!.getJSONObject("generationConfig").getJSONObject("responseJsonSchema").getJSONObject("properties").has("musicPrompt"))
                    assertFalse(body.getJSONObject("systemInstruction").toString().contains("EPISODE MUSIC DIRECTION"))
                    return response(1, "x".repeat(50))
                }
            }
            val file = File.createTempFile("music-memory", ".json")
            try {
                val planner = Planner(api, KeyRouter(listOf("one")), settings, templates(), file) { _, _, _ -> }
                assertFalse(planner.next().raw.has("musicPrompt"))
            } finally { file.delete(); api.close() }
        }
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
