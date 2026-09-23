package com.ronit.maestroradio

import org.junit.Assert.*
import org.junit.Test

class TranscriptTest {
    @Test fun `captions preserve actual spoken text and remove split tags`() {
        val clock = TranscriptClock(listOf(SpokenLine("[curious] Hola mundo.", true), SpokenLine("[curious] Hello world.", false)))
        clock.add("[cur", 0); clock.add("ious] Hola ", 2400); clock.add("mundo. [curious] Hello ", 4800); clock.add("world.", 7200); clock.finish(9600)
        assertEquals(1.0, clock.coverage, .001)
        assertEquals(" Hola mundo.  Hello world.", clock.cues.joinToString("") { it.text })
        assertEquals(listOf(true, false), clock.cues.map { it.target }.distinct())
        assertTrue(clock.cues.last().end <= 9600)
    }
    @Test fun `missing translation fails per line coverage`() {
        val clock = TranscriptClock(listOf(SpokenLine("Hola mundo.", true), SpokenLine("Hello world.", false)))
        clock.add("Hola mundo.", 2400); clock.finish(4800)
        assertEquals(0.0, clock.lineCoverage[1], .001)
        assertFalse(clock.cues.joinToString("") { it.text }.contains("Hello"))
    }
    @Test fun `timestamps already observed never stretch to final duration`() {
        val clock = TranscriptClock(listOf(SpokenLine("Hola mundo.", true)))
        clock.add("Hola ", 2400); val early = clock.cues.toList()
        clock.add("mundo.", 4800); clock.finish(24000)
        assertEquals(early, clock.cues.take(early.size))
    }
    @Test fun `env import deduplicates numbered keys and ignores unrelated values`() {
        val a = "AIza" + "a".repeat(35); val b = "AIza" + "b".repeat(35)
        assertEquals(listOf(a, b), parseKeys("GEMINI_API_KEY=$a\nGEMINI_API_KEY19='$b'\nGEMINI_API_KEY2=$a\nPASSWORD=unrelated-secret"))
    }
}
