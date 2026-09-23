package com.ronit.maestroradio

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class KeyRouterTest {
    @Test fun `quota cooldown is model specific and available keys are tried immediately`() = runBlocking {
        val pool = KeyRouter(listOf("one", "two"))
        val tried = mutableListOf<String>()
        assertEquals("two", pool.run("writer") { key -> tried.add(key); if (key == "one") throw ProviderFailure(429, 60000); key })
        assertEquals(listOf("one", "two"), tried)
        assertEquals("two", pool.run("writer") { it })
        assertEquals("one", pool.run("live") { it })
    }
    @Test fun `all limited projects fail without waiting through a daily cooldown`() = runBlocking {
        val pool = KeyRouter(listOf("one", "two", "three"))
        var tried = 0
        try { pool.run("writer") { tried++; throw ProviderFailure(429, 1000, true) }; fail("Expected quota failure") } catch (_: ProviderFailure) {}
        assertEquals(3, tried)
        try { pool.run("writer") { tried++; "unexpected" }; fail("Expected stored quota failure") } catch (_: ProviderFailure) {}
        assertEquals(3, tried)
    }
    @Test fun `cancelling a request does not rotate through more keys`() = runBlocking {
        val pool = KeyRouter(listOf("one", "two")); var tried = 0
        try { withTimeout(20) { pool.run("writer") { tried++; delay(5000) } }; fail("Expected cancellation") } catch (_: TimeoutCancellationException) {}
        assertEquals(1, tried)
    }
}
