package com.ronit.maestroradio

import android.app.*
import android.content.*
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.*

class RadioService : Service() {
    private lateinit var media: MediaSession
    private lateinit var audio: AudioManager
    private lateinit var focus: AudioFocusRequest
    private var resumeOnFocus = false
    private var wake: PowerManager.WakeLock? = null
    private val noisy = object : BroadcastReceiver() { override fun onReceive(context: Context?, intent: Intent?) { pause(true) } }
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("radio", "Listening", NotificationManager.IMPORTANCE_LOW))
        audio = getSystemService(AudioManager::class.java)
        focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener({ change ->
                when(change) {
                    AudioManager.AUDIOFOCUS_GAIN -> if (resumeOnFocus) { resumeOnFocus = false; pause(false) }
                    AudioManager.AUDIOFOCUS_LOSS -> { resumeOnFocus = false; pause(true) }
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> { resumeOnFocus = !RadioState.view.value.paused; pause(true) }
                }
            }, Handler(Looper.getMainLooper())).build()
        media = MediaSession(this, "Maestro Radio").apply {
            setCallback(object : MediaSession.Callback() { override fun onPlay() { pause(false) }; override fun onPause() { pause(true) }; override fun onStop() { RadioState.engine?.stop() } })
            setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, "Maestro Radio").putString(MediaMetadata.METADATA_KEY_ARTIST, "One thought. Two languages.").build())
            isActive = true
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), RECEIVER_NOT_EXPORTED)
        else registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when(intent?.action) {
            "pause" -> pause(!RadioState.view.value.paused)
            "stop" -> RadioState.engine?.stop()
            "start" -> {
                if (RadioState.view.value.active) return START_NOT_STICKY
                val preferences = Preferences(this)
                val keys = preferences.keys()
                if (keys.isEmpty()) { stopSelf(); return START_NOT_STICKY }
                if (Build.VERSION.SDK_INT >= 29) startForeground(1, notification(false), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
                else startForeground(1, notification(false))
                if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                    RadioState.view.value = RadioView(error = "Another app is using audio. Try again when it finishes."); stopSelf(); return START_NOT_STICKY
                }
                wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MaestroRadio:playback").apply { acquire(12 * 60 * 60 * 1000L) }
                val settings = RadioSettings.read(intent.getStringExtra("settings") ?: preferences.settings.json().toString())
                RadioState.engine = RadioEngine(this, settings, keys) {
                    if (wake?.isHeld == true) wake?.release()
                    audio.abandonAudioFocusRequest(focus); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
                }.also { it.start() }
                playback(false)
            }
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }
    private fun pause(value: Boolean) {
        if (!RadioState.view.value.active) return
        if (!value && audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return
        RadioState.engine?.pause(value)
        if (value) { if (wake?.isHeld == true) wake?.release() }
        else if (wake?.isHeld == false) wake?.acquire(12 * 60 * 60 * 1000L)
        playback(value); getSystemService(NotificationManager::class.java).notify(1, notification(value))
    }
    private fun playback(paused: Boolean) { media.setPlaybackState(PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP)
        .setState(if (paused) PlaybackState.STATE_PAUSED else PlaybackState.STATE_PLAYING, RadioState.view.value.elapsed * 1000, RadioState.view.value.speed).build()) }
    private fun notification(paused: Boolean): Notification {
        fun action(name: String) = PendingIntent.getService(this, name.hashCode(), Intent(this, RadioService::class.java).setAction(name), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, "radio").setSmallIcon(R.drawable.ic_radio).setContentTitle("Maestro Radio").setContentText(if (paused) "Paused" else "One thought. Two languages.")
            .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setOngoing(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(Notification.Action.Builder(null, if (paused) "Play" else "Pause", action("pause")).build())
            .addAction(Notification.Action.Builder(null, "End", action("stop")).build())
            .setStyle(Notification.MediaStyle().setMediaSession(media.sessionToken).setShowActionsInCompactView(0, 1)).build()
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        RadioState.engine?.stop(); if (wake?.isHeld == true) wake?.release(); audio.abandonAudioFocusRequest(focus); media.release(); unregisterReceiver(noisy)
        super.onDestroy()
    }
}
