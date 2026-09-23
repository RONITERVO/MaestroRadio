package com.ronit.maestroradio

import java.text.Normalizer
import java.util.Locale
import kotlin.math.roundToLong

private val voiceTags = setOf("curious", "excited", "happy", "sad", "surprised", "contemplative", "whispering", "muttering", "annoyed", "unbelieving", "laughing", "chuckles", "sighs", "gasps", "clears throat", "short pause")
private val brackets = Regex("\\[([^]\\r\\n]+)]")
fun stripTags(text: String) = brackets.replace(text) { if (it.groupValues[1].lowercase() in voiceTags || it.groupValues[1].matches(Regex("[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*"))) "" else it.value }
fun unknownTags(text: String) = brackets.findAll(text).any { it.groupValues[1].lowercase() !in voiceTags }
fun fingerprint(text: String) = Normalizer.normalize(stripTags(text), Normalizer.Form.NFKC).lowercase(Locale.ROOT).replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()
private val wordPattern = Regex("[\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}]|[\\p{L}\\p{M}\\p{N}]+|[^\\p{L}\\p{M}\\p{N}]")
private fun tokens(text: String) = wordPattern.findAll(text).map { it.value }.toList()
data class Caption(val text: String, val line: Int, val target: Boolean, val start: Long, val end: Long)
class TranscriptClock(private val lines: List<SpokenLine>) {
    private data class Expected(val key: String, val line: Int)
    private val expected = lines.flatMapIndexed { i, line -> tokens(stripTags(line.text)).filter { fingerprint(it).isNotEmpty() }.map { Expected(fingerprint(it), i) } }
    private val matched = mutableSetOf<Int>()
    val cues = mutableListOf<Caption>()
    var raw = ""; private set
    private var tail = ""
    private var cursor = 0
    private var line = 0
    private var anchor = 0L
    private val waiting = mutableListOf<Pair<String, Int>>()
    val coverage get() = matched.size.toDouble() / expected.size.coerceAtLeast(1)
    val lineCoverage get() = lines.indices.map { line -> val indices = expected.indices.filter { expected[it].line == line }; indices.count { it in matched }.toDouble() / indices.size.coerceAtLeast(1) }
    fun add(fragment: String, samples: Long) { raw += fragment; tail += fragment; consume(false); flush(samples, false) }
    fun audio(samples: Long) { flush(samples, false) }
    fun finish(samples: Long) { consume(true); flush(samples, true) }
    private fun consume(final: Boolean) {
        var end = tail.length
        val bracket = tail.lastIndexOf('[')
        if (!final && bracket > tail.lastIndexOf(']')) end = bracket
        if (!final) {
            val last = wordPattern.findAll(tail.substring(0, end)).lastOrNull()
            if (last != null && fingerprint(last.value).isNotEmpty()) end = last.range.first
        }
        val text = stripTags(tail.substring(0, end)); tail = tail.substring(end)
        for (token in tokens(text)) {
            val key = fingerprint(token)
            if (key.isNotEmpty()) {
                val index = (cursor until minOf(expected.size, cursor + 16)).firstOrNull { expected[it].key == key }
                if (index != null) { line = expected[index].line; cursor = index + 1; matched.add(index) }
            }
            waiting.add(token.replace(Regex("[\\r\\n\\t]+"), " ") to line)
        }
    }
    private fun flush(samples: Long, final: Boolean) {
        if (waiting.isEmpty() || (samples <= anchor && !final)) return
        val end = maxOf(anchor, samples); val weight = waiting.sumOf { it.first.length }.coerceAtLeast(1); var consumed = 0
        for ((text, line) in waiting) {
            cues.add(Caption(text, line, lines[line].target, anchor + ((end - anchor).toDouble() * consumed / weight).roundToLong(),
                anchor + ((end - anchor).toDouble() * (consumed + text.length) / weight).roundToLong()))
            consumed += text.length
        }
        anchor = end; waiting.clear()
    }
}
