package com.ronit.maestroradio

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import java.util.Locale

class MainActivity : Activity() {
    private val ink = Color.rgb(233, 236, 226)
    private val muted = Color.rgb(150, 157, 149)
    private val accent = Color.rgb(212, 233, 187)
    private val background = Color.rgb(8, 9, 9)
    private lateinit var preferences: Preferences
    private lateinit var root: LinearLayout
    private lateinit var setup: ScrollView
    private lateinit var setupFields: LinearLayout
    private lateinit var transcriptScroll: ScrollView
    private lateinit var transcript: LinearLayout
    private lateinit var controls: LinearLayout
    private lateinit var startButton: Button
    private lateinit var stateText: TextView
    private lateinit var errorText: TextView
    private lateinit var pauseButton: Button
    private lateinit var endButton: Button
    private lateinit var speedButton: Button
    private lateinit var topic: EditText
    private lateinit var style: EditText
    private lateinit var musicPrompt: EditText
    private lateinit var target: Spinner
    private lateinit var native: Spinner
    private lateinit var level: Spinner
    private lateinit var voice: Spinner
    private lateinit var expressive: CheckBox
    private lateinit var music: CheckBox
    private var musicVolume = .6f
    private var speed = 1f
    private var collector: Job? = null
    private var follow = true
    private var showingEpisode = false
    private val textViews = linkedMapOf<Int, TextView>()
    private val speeds = listOf(1f, 1.25f, 1.5f, 1.75f, 2f)
    private var exportedText = ""
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun label(text: String, size: Float = 13f, color: Int = muted) = TextView(this).apply { this.text = text; textSize = size; setTextColor(color); setPadding(0, dp(10), 0, dp(8)) }
    private fun button(text: String, action: () -> Unit) = Button(this).apply { this.text = text; isAllCaps = false; setTextColor(accent); textSize = 14f; setOnClickListener { action() } }
    private fun input(hint: String, text: String, limit: Int, lines: Int = 1) = EditText(this).apply {
        this.hint = hint; setText(text); setTextColor(ink); setHintTextColor(muted); textSize = 17f
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or if (lines > 1) InputType.TYPE_TEXT_FLAG_MULTI_LINE else 0
        maxLines = lines; minLines = 1; filters = arrayOf(InputFilter.LengthFilter(limit)); setPadding(0, dp(8), 0, dp(10))
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
    }
    private fun select(values: List<String>, selected: Int) = Spinner(this).apply {
        adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, values)
        setSelection(selected); minimumHeight = dp(48)
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        preferences = Preferences(this); preferences.importProvisionedKeys()
        val saved = preferences.settings; speed = saved.speed; musicVolume = saved.musicVolume
        root = column().apply { setBackgroundColor(this@MainActivity.background); setPadding(dp(22), dp(6), dp(22), dp(8)) }
        root.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.ime())
                view.setPadding(dp(22) + bars.left, bars.top + dp(6), dp(22) + bars.right, bars.bottom + dp(8))
            } else view.setPadding(dp(22), insets.systemWindowInsetTop + dp(6), dp(22), insets.systemWindowInsetBottom + dp(8))
            insets
        }
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        val header = row()
        header.addView(label("▥  MAESTRO RADIO", 14f, accent), LinearLayout.LayoutParams(0, dp(54), 1f))
        header.addView(button("Settings ↗") { settingsDialog() })
        root.addView(header)
        errorText = label("", 13f, Color.rgb(236, 189, 154)).apply { visibility = View.GONE }
        root.addView(errorText)
        setupFields = column()
        setup = ScrollView(this).apply { isFillViewport = false; addView(setupFields) }
        setupFields.addView(label("ONE THOUGHT. TWO LANGUAGES.", 11f, accent))
        setupFields.addView(label("Follow a thought.\nFind the words.", 36f, ink).apply { typeface = Typeface.create("serif", Typeface.NORMAL); setPadding(0, dp(14), 0, dp(14)) })
        setupFields.addView(label("A podcast that keeps unfolding.\nListen in a new language, one sentence at a time.", 16f))
        setupFields.addView(label("WHERE SHALL WE BEGIN?", 11f))
        topic = input("Deep oceans, hidden cities, anything…", saved.topic, 2000, 3).apply { contentDescription = "Topic" }
        setupFields.addView(topic)
        setupFields.addView(button("↝  Surprise me") { topic.setText(""); begin() })
        val languages = row()
        fun languageField(title: String, index: Int): Spinner {
            val field = column(); field.addView(label(title, 11f)); val spinner = select(LANGUAGES.map { it.name }, index); field.addView(spinner)
            languages.addView(field, LinearLayout.LayoutParams(0, -2, 1f)); return spinner
        }
        target = languageField("I’M LEARNING", saved.target); native = languageField("TRANSLATE INTO", saved.native)
        setupFields.addView(languages)
        val detail = row()
        val levels = listOf("A1", "A2", "B1", "B2", "C1")
        val voices = listOf("Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr")
        val levelField = column(); levelField.addView(label("LEVEL", 11f)); level = select(levels, levels.indexOf(saved.level).coerceAtLeast(0)); levelField.addView(level)
        val voiceField = column(); voiceField.addView(label("VOICE", 11f)); voice = select(voices, voices.indexOf(saved.voice).coerceAtLeast(0)); voiceField.addView(voice)
        detail.addView(levelField, LinearLayout.LayoutParams(0, -2, 1f)); detail.addView(voiceField, LinearLayout.LayoutParams(0, -2, 1f)); setupFields.addView(detail)
        val optional = column().apply { visibility = View.GONE }
        setupFields.addView(button("Style & music  ▾") { optional.visibility = if (optional.visibility == View.VISIBLE) View.GONE else View.VISIBLE })
        setupFields.addView(optional)
        optional.addView(label("HOW SHOULD IT FEEL?", 11f))
        style = input("Make me the main character in a funny folk tale…", saved.style, 1200, 4); optional.addView(style)
        val presets = row()
        listOf("Folk tale" to "Tell it as a whimsical folk tale, with recurring characters and gentle humor.", "Comedy" to "Make me the main character in a playful comedy with escalating mishaps and callbacks.").forEach { (name, text) ->
            presets.addView(button(name) { style.setText(text) }, LinearLayout.LayoutParams(0, -2, 1f))
        }; optional.addView(presets)
        expressive = CheckBox(this).apply { text = "Expressive voice"; isChecked = saved.expressive; setTextColor(ink) }; optional.addView(expressive)
        music = CheckBox(this).apply { text = "Lyria background music"; isChecked = saved.music; setTextColor(ink) }; optional.addView(music)
        musicPrompt = input("Automatic for this podcast · or describe your own music…", saved.musicPrompt, 1000, 5); optional.addView(musicPrompt)
        optional.addView(label("Leave blank for a score tailored to your topic and style. Music softens under speech. Both streams use your Gemini keys.", 13f))
        setupFields.addView(label("BYOK · DIRECT FROM YOUR PHONE", 11f))
        root.addView(setup, LinearLayout.LayoutParams(-1, 0, 1f))
        transcript = column().apply { setPadding(0, dp(24), 0, dp(32)) }
        transcriptScroll = ScrollView(this).apply {
            addView(transcript); visibility = View.GONE
            setOnTouchListener { _, _ -> follow = false; false }
            setOnScrollChangeListener { _, _, scrollY, _, oldY -> if (scrollY > oldY && transcript.height - scrollY <= height + dp(60)) follow = true }
        }
        root.addView(transcriptScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        stateText = label("", 12f, muted); root.addView(stateText)
        startButton = button("Begin listening  ↗") { begin() }.apply { textSize = 17f; minimumHeight = dp(58) }; root.addView(startButton)
        controls = row().apply { visibility = View.GONE }
        pauseButton = button("Pause") { startService(Intent(this, RadioService::class.java).setAction("pause")) }
        speedButton = button("${speed}×") {
            speed = speeds[(speeds.indexOf(speed).coerceAtLeast(0) + 1) % speeds.size]; RadioState.engine?.speed(speed); speedButton.text = "${speed}×"
            preferences.settings = preferences.settings.copy(speed = speed)
        }
        endButton = button("End") { if (RadioState.view.value.active) startService(Intent(this, RadioService::class.java).setAction("stop")) else newEpisode() }
        listOf(pauseButton, speedButton, endButton).forEach { controls.addView(it, LinearLayout.LayoutParams(0, dp(54), 1f)) }; root.addView(controls)
        setContentView(root)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    override fun onStart() {
        super.onStart()
        collector = CoroutineScope(Dispatchers.Main).launch { RadioState.view.collectLatest { render(it) } }
    }
    override fun onStop() { collector?.cancel(); super.onStop() }
    private fun currentSettings(): RadioSettings = RadioSettings(topic.text.toString().trim(), target.selectedItemPosition, native.selectedItemPosition, level.selectedItem.toString(),
        style.text.toString().trim(), expressive.isChecked, voice.selectedItem.toString(), speed, music.isChecked, musicPrompt.text.toString().trim(), musicVolume)
    private fun begin() {
        if (RadioState.view.value.active) return
        if (preferences.keys().isEmpty()) { keyDialog(); return }
        val selected = currentSettings()
        if (selected.target == selected.native) { errorText.text = "Choose two different languages."; errorText.visibility = View.VISIBLE; return }
        preferences.settings = selected
        val seeds = listOf("How a city wakes up before sunrise: follow its hidden workers.", "What forests do after dark: begin with a moth finding a flower.", "Follow the secret journey of a ceramic cup, from clay to a kitchen.", "How people found their way before GPS: a sailor watches the stars.")
        val settings = if (selected.topic.isBlank()) selected.copy(topic = seeds.random()) else selected
        follow = true; textViews.clear(); transcript.removeAllViews(); showingEpisode = true
        (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).hideSoftInputFromWindow(topic.windowToken, 0)
        startForegroundService(Intent(this, RadioService::class.java).setAction("start").putExtra("settings", settings.json().toString()))
    }
    private fun newEpisode() { showingEpisode = false; RadioState.view.value = RadioView(); render(RadioState.view.value) }
    private fun render(state: RadioView) {
        if (state.active || state.lines.isNotEmpty()) showingEpisode = true
        setup.visibility = if (showingEpisode) View.GONE else View.VISIBLE
        startButton.visibility = if (showingEpisode) View.GONE else View.VISIBLE
        transcriptScroll.visibility = if (showingEpisode) View.VISIBLE else View.GONE
        controls.visibility = if (showingEpisode) View.VISIBLE else View.GONE
        pauseButton.visibility = if (state.active) View.VISIBLE else View.GONE
        pauseButton.text = if (state.paused) "Play" else "Pause"
        endButton.text = if (state.active) "End" else "New episode"
        speedButton.text = "${if (state.active) state.speed else speed}×"
        stateText.text = if (showingEpisode) "${state.status}   ${state.elapsed / 60}:${(state.elapsed % 60).toString().padStart(2, '0')}   ·   ${String.format(Locale.US, "%.1f", state.used * 100.0 / state.limit.coerceAtLeast(1))}% memory"
            else if (preferences.keys().isEmpty()) "Add Gemini keys in Settings to begin." else "${preferences.keys().size} keys ready. Settle in and listen."
        errorText.text = state.error; errorText.visibility = if (state.error.isBlank()) View.GONE else View.VISIBLE
        if (state.active) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        var changed = false
        for (line in state.lines) {
            val view = textViews.getOrPut(line.id) {
                label("", if (line.target) 25f else 19f, if (line.target) ink else muted).apply {
                    typeface = Typeface.create("serif", Typeface.NORMAL); setLineSpacing(dp(5).toFloat(), 1f)
                    setPadding(0, if (line.target) dp(24) else dp(6), 0, dp(8)); textDirection = View.TEXT_DIRECTION_FIRST_STRONG
                    transcript.addView(this)
                }
            }
            val text = line.text.trimStart()
            if (view.text.toString() != text) { view.text = text; changed = true }
        }
        val visible = state.lines.map { it.id }.toSet()
        textViews.keys.filter { it !in visible }.forEach { transcript.removeView(textViews.remove(it)); changed = true }
        if (changed && follow) transcriptScroll.post { transcriptScroll.smoothScrollTo(0, transcript.height) }
    }
    private fun settingsDialog() {
        val panel = column().apply { setPadding(dp(20), dp(8), dp(20), dp(8)) }
        panel.addView(button("Gemini keys · ${preferences.keys().size} saved") { keyDialog() })
        panel.addView(label("PLAYBACK SPEED", 11f))
        panel.addView(select(speeds.map { "${it}×" }, speeds.indexOf(speed).coerceAtLeast(0)).apply {
            contentDescription = "Playback speed"
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                    speed = speeds[position]; RadioState.engine?.speed(speed); speedButton.text = "${speed}×"
                    preferences.settings = preferences.settings.copy(speed = speed)
                }
                override fun onNothingSelected(parent: AdapterView<*>?) {}
            }
        })
        panel.addView(label("MUSIC VOLUME", 11f))
        panel.addView(SeekBar(this).apply {
            max = 100; progress = (musicVolume * 100).toInt(); contentDescription = "Music volume"
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seek: SeekBar?, progress: Int, fromUser: Boolean) { if (fromUser) { musicVolume = progress / 100f; RadioState.engine?.volume(musicVolume); preferences.settings = preferences.settings.copy(musicVolume = musicVolume) } }
                override fun onStartTrackingTouch(seek: SeekBar?) {}; override fun onStopTrackingTouch(seek: SeekBar?) {}
            })
        })
        panel.addView(label(RadioState.view.value.music.ifBlank { "Music follows pause and resume. Enable it under Style & music for your next episode." }, 13f))
        if (RadioState.view.value.musicPrompt.isNotBlank()) panel.addView(label("THIS EPISODE’S MUSIC\n${RadioState.view.value.musicPrompt}", 13f))
        panel.addView(label("WRITER  ${RadioState.view.value.writer}\nFALLBACKS  3 Flash → 2.5 Flash Lite\nVOICE  Gemini Live\nMUSIC  Lyria RealTime · Quality", 11f))
        panel.addView(button("Save spoken transcript") {
            exportedText = RadioState.engine?.transcript() ?: RadioState.view.value.lines.joinToString("\n\n") { it.text }
            startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("text/plain").putExtra(Intent.EXTRA_TITLE, "maestro-radio.txt"), 3)
        })
        AlertDialog.Builder(this).setTitle("Make it yours.").setView(ScrollView(this).apply { addView(panel) }).setPositiveButton("Done", null).show()
    }
    private fun keyDialog() {
        val panel = column().apply { setPadding(dp(20), dp(8), dp(20), dp(8)) }
        panel.addView(label("Paste one key per line, or import a .env file. Keys are encrypted on this phone and sent only to Google.", 14f))
        val field = input("Gemini keys or .env contents", "", 30000, 6).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setHorizontallyScrolling(false)
        }
        panel.addView(field)
        panel.addView(label("${preferences.keys().size} saved keys. Saving replaces the pool. Leave blank to keep it.", 12f))
        val dialog = AlertDialog.Builder(this).setTitle("Your Gemini keys").setView(panel).setPositiveButton("Save") { _, _ ->
            if (field.text.isNotBlank()) {
                if (parseKeys(field.text.toString()).isEmpty()) Toast.makeText(this, "No valid keys found.", Toast.LENGTH_LONG).show()
                else preferences.saveKeys(field.text.toString())
            }; render(RadioState.view.value)
        }.setNeutralButton("Import .env") { _, _ -> startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), 2) }
            .setNegativeButton("Cancel", null).create()
        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        dialog.show(); dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
    @Deprecated("Platform document picker")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data?.data == null) return
        runCatching {
            if (requestCode == 2) {
                val raw = contentResolver.openInputStream(data.data!!)?.bufferedReader()?.use { reader -> val buffer = CharArray(65536); val count = reader.read(buffer); if (count > 0) String(buffer, 0, count) else "" } ?: ""
                check(parseKeys(raw).isNotEmpty()) { "No Gemini keys found." }; preferences.saveKeys(raw)
                Toast.makeText(this, "${preferences.keys().size} keys imported", Toast.LENGTH_SHORT).show(); render(RadioState.view.value)
            } else if (requestCode == 3) contentResolver.openOutputStream(data.data!!)?.bufferedWriter()?.use { it.write(exportedText) }
        }.onFailure { Toast.makeText(this, "Could not read or save that file.", Toast.LENGTH_LONG).show() }
    }
}
