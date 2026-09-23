package com.ronit.maestroradio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.PlaybackParams
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.pow

/** Hardware playback heads are the transcript clock. Music has a separate, unsped stereo clock. */
class NativePlayer(private val scope: CoroutineScope, initialSpeed: Float, initialMusicVolume: Float,
                   private val onMusicFailure: (Throwable) -> Unit, private val onFailure: (Throwable) -> Unit) {
    private val voice = track(24000, 1)
    private var music: AudioTrack? = null
    private var musicRate = 48000
    private val voiceQueue = Channel<ByteArray>(8)
    private val musicQueue = Channel<ByteArray>(32)
    private val jobs = mutableListOf<Job>()
    private val totalVoice = AtomicLong(0)
    private val totalMusic = AtomicLong(0)
    private val levels = ArrayDeque<Pair<Long, Float>>()
    private var lastHead = 0L; private var headWrap = 0L
    @Volatile var paused = false; private set
    @Volatile var stopped = false; private set
    @Volatile var speed = initialSpeed; private set
    @Volatile var musicVolume = initialMusicVolume
    var peakBufferedMusic = 0.0; private set
    init {
        voice.setVolume(.8f) // Reserve guaranteed headroom for stereo music (maximum .2).
        setSpeed(initialSpeed); voice.play()
        jobs.add(scope.launch(Dispatchers.IO) { pump(voiceQueue) { voice } })
        jobs.add(scope.launch(Dispatchers.IO) { pump(musicQueue, true) { music ?: throw RadioFailure("Music player was not initialized.") } })
        jobs.add(scope.launch(Dispatchers.Default) {
            var envelope = 0.0; var gain = 1.0; var fade = 0.0
            while (isActive && !stopped) {
                if (!paused) {
                    val head = playedSamples
                    val level = synchronized(levels) {
                        while (levels.size > 1 && levels.elementAt(1).first <= head) levels.removeFirst()
                        if (head >= totalVoice.get()) 0.0 else (levels.firstOrNull()?.second ?: 0f).toDouble()
                    }
                    val coefficient = exp(-.012 / if (level > envelope) .012 else .42)
                    envelope = coefficient * envelope + (1 - coefficient) * level
                    val desired = if (envelope <= .06) 1.0 else (.06 / envelope).pow(1 - 1.0 / 9)
                    val smoothing = exp(-.012 / if (desired < gain) .012 else .42)
                    gain = smoothing * gain + (1 - smoothing) * desired
                    if (music != null) fade = minOf(1.0, fade + .012 / 2.5)
                    music?.setVolume((.2 * musicVolume * gain * fade).toFloat())
                }
                delay(12)
            }
        })
    }
    private fun track(rate: Int, channels: Int): AudioTrack {
        val mask = if (channels == 1) AudioFormat.CHANNEL_OUT_MONO else AudioFormat.CHANNEL_OUT_STEREO
        val minimum = AudioTrack.getMinBufferSize(rate, mask, AudioFormat.ENCODING_PCM_16BIT)
        return AudioTrack.Builder().setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(mask).build())
            .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(maxOf(minimum * 4, rate * channels)).build().also {
                check(it.state == AudioTrack.STATE_INITIALIZED) { "AudioTrack initialization failed" }
            }
    }
    @Synchronized fun setSpeed(value: Float) { if (stopped) return; speed = value.coerceIn(1f, 2f); voice.playbackParams = PlaybackParams().setSpeed(speed).setPitch(1f).setAudioFallbackMode(PlaybackParams.AUDIO_FALLBACK_MODE_FAIL); if (paused) voice.pause() }
    @Synchronized fun pause(value: Boolean) {
        if (stopped) return
        paused = value
        if (value) { voice.pause(); music?.pause() } else { voice.play(); music?.play() }
    }
    @get:Synchronized val playedSamples: Long get() {
        if (stopped) return lastHead + headWrap
        val current = voice.playbackHeadPosition.toLong() and 0xffffffffL
        if (current < lastHead) headWrap += 1L shl 32
        lastHead = current
        return minOf(totalVoice.get(), current + headWrap)
    }
    val queuedVoiceSamples get() = totalVoice.get() - playedSamples
    val musicBufferedSeconds get() = music?.let { (totalMusic.get() - (it.playbackHeadPosition.toLong() and 0xffffffffL)).coerceAtLeast(0).toDouble() / musicRate } ?: 0.0
    suspend fun enqueueVoice(pcm: ByteArray): Long {
        check(pcm.size % 2 == 0)
        val start = totalVoice.getAndAdd(pcm.size / 2L)
        synchronized(levels) {
            for (offset in pcm.indices step 960) {
                val end = minOf(offset + 960, pcm.size); var sum = 0.0
                for (i in offset until end step 2) { val sample = ((pcm[i].toInt() and 255) or (pcm[i+1].toInt() shl 8)).toShort(); sum += abs(sample.toInt()) / 32768.0 }
                levels.addLast((start + offset / 2) to (sum / ((end - offset) / 2).coerceAtLeast(1)).toFloat())
            }
        }
        voiceQueue.send(pcm)
        return start
    }
    suspend fun enqueueMusic(pcm: ByteArray, rate: Int, channels: Int) {
        if (channels != 2 || rate !in listOf(44100, 48000) || pcm.size % 4 != 0) throw RadioFailure("Unsupported music format.")
        if (music == null) synchronized(this) {
            if (stopped) return
            musicRate = rate; music = track(rate, channels).also { it.setVolume(0f); if (!paused) it.play() }
        }
        if (rate != musicRate) throw RadioFailure("Music format changed during playback.")
        if (musicBufferedSeconds > 30) throw RadioFailure("Music buffer exceeded its limit.")
        totalMusic.addAndGet(pcm.size / 4L); musicQueue.send(pcm)
        peakBufferedMusic = maxOf(peakBufferedMusic, musicBufferedSeconds)
    }
    private suspend fun pump(queue: Channel<ByteArray>, musicOnly: Boolean = false, getTrack: () -> AudioTrack) {
        try {
            for (pcm in queue) {
                var offset = 0
                while (offset < pcm.size && !stopped) {
                    currentCoroutineContext().ensureActive()
                    if (paused) { delay(20); continue }
                    val written = getTrack().write(pcm, offset, pcm.size - offset, AudioTrack.WRITE_NON_BLOCKING)
                    if (written < 0) throw RadioFailure("Audio playback failed ($written).")
                    offset += written
                    if (written == 0) delay(8)
                }
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (!stopped) {
                if (musicOnly) { musicQueue.cancel(); onMusicFailure(error) }
                else onFailure(error)
            }
        }
    }
    suspend fun close() {
        synchronized(this) { if (stopped) return; playedSamples; stopped = true }
        voiceQueue.cancel(); musicQueue.cancel(); jobs.forEach { it.cancel() }; jobs.joinAll()
        synchronized(this) { voice.release(); music?.release(); music = null }
    }
}
