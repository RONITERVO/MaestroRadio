package com.ronit.maestroradio

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class Language(val code: String, val name: String)
val LANGUAGES = listOf("es-ES:Spanish", "en-US:English", "fi-FI:Finnish", "fr-FR:French", "de-DE:German", "it-IT:Italian", "pt-BR:Portuguese", "sv-SE:Swedish", "nl-NL:Dutch", "pl-PL:Polish", "tr-TR:Turkish", "el-GR:Greek", "ru-RU:Russian", "uk-UA:Ukrainian", "ja-JP:Japanese", "ko-KR:Korean", "cmn-CN:Mandarin Chinese", "ar-XA:Arabic", "hi-IN:Hindi", "bn-IN:Bengali", "id-ID:Indonesian", "vi-VN:Vietnamese", "th-TH:Thai", "ro-RO:Romanian").map { Language(it.substringBefore(':'), it.substringAfter(':')) }
const val LEGACY_MUSIC = "Warm cinematic ambient, soft felt piano, gentle acoustic textures, spacious and slowly evolving, instrumental, understated documentary score"
data class RadioSettings(
    val topic: String = "", val target: Int = 0, val native: Int = 1, val level: String = "B1",
    val style: String = "", val expressive: Boolean = false, val voice: String = "Kore",
    val speed: Float = 1f, val music: Boolean = true, val musicPrompt: String = "", val musicVolume: Float = .6f
) {
    fun json() = JSONObject().put("topic", topic).put("target", target).put("native", native).put("level", level)
        .put("style", style).put("expressive", expressive).put("voice", voice).put("speed", speed.toDouble()).put("music", music).put("musicPrompt", musicPrompt).put("musicVolume", musicVolume.toDouble())
    companion object {
        fun read(value: String): RadioSettings {
            val j = runCatching { JSONObject(value) }.getOrDefault(JSONObject())
            return RadioSettings(j.optString("topic").take(2000), j.optInt("target", 0).coerceIn(LANGUAGES.indices), j.optInt("native", 1).coerceIn(LANGUAGES.indices),
                j.optString("level", "B1"), j.optString("style").take(1200), j.optBoolean("expressive"), j.optString("voice", "Kore"),
                j.optDouble("speed", 1.0).toFloat().coerceIn(1f, 2f), j.optBoolean("music", true), j.optString("musicPrompt").trim().take(1000), j.optDouble("musicVolume", .6).toFloat().coerceIn(0f, 1f))
        }
    }
}

/** API keys are encrypted with a non-exportable Android Keystore key; excluded from backups. */
class Preferences(private val context: Context) {
    private val prefs = context.getSharedPreferences("radio", Context.MODE_PRIVATE)
    var settings: RadioSettings
        get() {
            var saved = RadioSettings.read(prefs.getString("settings", "{}")!!)
            if (!prefs.getBoolean("autoMusicV1", false)) {
                if (saved.musicPrompt == LEGACY_MUSIC) saved = saved.copy(musicPrompt = "")
                prefs.edit().putString("settings", saved.json().toString()).putBoolean("autoMusicV1", true).apply()
            }
            return saved
        }
        set(value) { prefs.edit().putString("settings", value.json().toString()).apply() }
    private fun secret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("radio-byok", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("radio-byok", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun keys(): List<String> = runCatching {
        val stored = prefs.getString("keys", null) ?: return emptyList()
        val parts = stored.split(':')
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
        parseKeys(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)).toString(Charsets.UTF_8))
    }.getOrDefault(emptyList())
    fun saveKeys(value: String) {
        val keys = parseKeys(value)
        if (keys.isEmpty()) { prefs.edit().remove("keys").commit(); return }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secret())
        val encrypted = cipher.doFinal(keys.joinToString("\n").toByteArray())
        check(prefs.edit().putString("keys", Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit())
    }
    fun importProvisionedKeys() {
        val file = File(context.filesDir, "import-keys.env")
        if (file.exists()) { try { saveKeys(file.readText()) } finally { file.delete() } }
    }
}
fun parseKeys(value: String): List<String> {
    val env = Regex("(?m)^\\s*(?:export\\s+)?(?:GEMINI_API_KEYS|GEMINI_API_KEY_?\\d*|GOOGLE_API_KEY|PLANNER_API_KEYS|LIVE_API_KEYS|MUSIC_API_KEYS)\\s*=\\s*(.+)$")
    val matches = env.findAll(value).map { it.groupValues[1].substringBefore(" #").trim().trim('"', '\'') }.toList()
    val raw = if (matches.isNotEmpty()) matches.joinToString("\n") else value
    return raw.split(Regex("[\\s,;]+" )).map { it.trim('"', '\'') }.filter { it.matches(Regex("[A-Za-z0-9_-]{20,256}")) }.distinct().take(100)
}
