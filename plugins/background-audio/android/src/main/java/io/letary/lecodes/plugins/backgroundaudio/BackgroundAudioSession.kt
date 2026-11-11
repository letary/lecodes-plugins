//
//  BackgroundAudioSession.kt — lecodes-plugins/background-audio
//
//  The app's session of the channel: it drives the player of BackgroundAudioService through a
//  MediaController (the supported way in: connecting binds the service, playing puts it in the
//  foreground) and says what the player does — the state, the length, the position. The controller
//  is made at the first `play`; calls made before it connected wait for it, in their order. The
//  channel (the calls, the events, their types) is BackgroundAudio.gen.kt, generated from
//  contract.d.ts. Main thread.
//
//  The state is read off the player after every change of it, whoever made it — the app, the
//  notification's button, a headset, a call that took the audio focus: there is one place that
//  says it (`sync`). The position is a `@lazy` event: it ticks only while the app listens AND is in
//  the foreground (its code does not run in the background: the events would pile up).
//

package io.letary.lecodes.plugins.backgroundaudio

import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import io.letary.lecodes.services.NoCode
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve

class BackgroundAudioSession(
    private val context: Context,
    private val events: BackgroundAudioEvents,
) : BackgroundAudioPlugin, Player.Listener, DefaultLifecycleObserver {

    private val main = Handler(Looper.getMainLooper())
    private var connecting: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    /** The calls made before the controller connected. */
    private val waiting = ArrayList<(MediaController) -> Unit>()

    private var state = PlaybackState.IDLE
    /** Seconds; 0 while the record's length is not known. */
    private var duration = 0.0
    /** Where the record starts, asked before there was a player to ask. */
    private var startAt = 0.0
    private var foreground = true
    private var closed = false

    private val ticker = object : Runnable {
        override fun run() {
            tick()
            main.postDelayed(this, TICK_MS)
        }
    }

    init {
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
    }

    // ── the controller ───────────────────────────────────────────────────────

    /** Run `call` on the controller: now, or once it has connected. */
    private fun withController(call: (MediaController) -> Unit) {
        controller?.let { return call(it) }
        waiting.add(call)
        if (connecting != null) return
        val token = SessionToken(context, ComponentName(context, BackgroundAudioService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        connecting = future
        future.addListener({
            val connected = try { future.get() } catch (e: Exception) { null }
            if (closed) {
                connected?.release()
                return@addListener
            }
            if (connected == null) {
                // The service could not be bound: the record cannot play.
                connecting = null
                waiting.clear()
                set(PlaybackState.FAILED)
                return@addListener
            }
            controller = connected
            connected.addListener(this)
            val calls = waiting.toList()
            waiting.clear()
            for (queued in calls) queued(connected)
            sync()
        }, ContextCompat.getMainExecutor(context))
    }

    /** The same, for a call that means nothing before the first `play`: no controller is made for it. */
    private fun ifStarted(call: (MediaController) -> Unit) {
        if (controller != null || connecting != null) withController(call)
    }

    // ── what the player does ─────────────────────────────────────────────────

    override fun onEvents(player: Player, events: Player.Events) = sync()

    /** The state and the length as the player has them now. */
    private fun sync() {
        val c = controller ?: return
        val length = c.duration
        if (length != C.TIME_UNSET && length > 0 && c.mediaItemCount > 0) {
            val seconds = length / 1000.0
            if (seconds != duration) {
                duration = seconds
                events.duration(value = seconds)
            }
        }
        set(when {
            c.mediaItemCount == 0 -> PlaybackState.IDLE
            c.playerError != null -> PlaybackState.FAILED
            c.playbackState == Player.STATE_ENDED -> PlaybackState.ENDED
            // Paused by the app, a button, or the system: a call took the audio focus.
            c.playbackState == Player.STATE_READY ->
                if (c.playWhenReady && c.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE) PlaybackState.PLAYING else PlaybackState.PAUSED
            // Buffering — or prepared a moment ago and not buffering yet.
            else -> if (c.playWhenReady) PlaybackState.LOADING else PlaybackState.PAUSED
        })
    }

    private fun set(next: PlaybackState) {
        if (next == state) return
        state = next
        events.state(value = next)
        tick()          // what moved the state moved the position: a listener hears where it stands
        pace()
    }

    private fun position(): Double {
        val c = controller ?: return startAt
        return if (c.mediaItemCount > 0) c.currentPosition.coerceAtLeast(0) / 1000.0 else 0.0
    }

    private fun tick() {
        if (foreground) events.position(value = position())      // sent only while the app listens: the glue's
    }

    /** The position ticks only while the record plays, the app listens and is in the foreground. */
    private fun pace() {
        main.removeCallbacks(ticker)
        if (events.positionObserved && foreground && state == PlaybackState.PLAYING) main.postDelayed(ticker, TICK_MS)
    }

    override fun onStart(owner: LifecycleOwner) {
        foreground = true
        tick()
        pace()
    }

    override fun onStop(owner: LifecycleOwner) {
        foreground = false
        pace()
    }

    // ── the calls ────────────────────────────────────────────────────────────

    override fun play(track: Track, reply: Reply<Unit, NoCode>) {
        startAt = (track.position ?: 0.0).coerceAtLeast(0.0)
        duration = 0.0
        set(PlaybackState.LOADING)
        val from = (startAt * 1000).toLong()
        withController { c ->
            val item = MediaItem.Builder()
                .setUri(track.src)
                .setMediaMetadata(MediaMetadata.Builder().setTitle(track.title).setArtist(track.artist).build())
                .build()
            c.setMediaItem(item, from)
            c.prepare()
            c.play()
        }
        reply.resolve()
    }

    override fun pause(reply: Reply<Unit, NoCode>) {
        ifStarted { it.pause() }
        reply.resolve()
    }

    override fun resume(reply: Reply<Unit, NoCode>) {
        ifStarted { c ->
            if (c.mediaItemCount == 0) return@ifStarted
            if (c.playbackState == Player.STATE_ENDED) c.seekTo(0)
            if (c.playbackState == Player.STATE_IDLE) c.prepare()       // after a failure: ask for the record again
            c.play()
        }
        reply.resolve()
    }

    override fun seek(position: Double, reply: Reply<Unit, NoCode>) {
        val at = position.coerceAtLeast(0.0).let { if (duration > 0) it.coerceAtMost(duration) else it }
        startAt = at
        ifStarted { c ->
            if (c.mediaItemCount > 0) c.seekTo((at * 1000).toLong())
            tick()
        }
        reply.resolve()
    }

    override fun stop(reply: Reply<Unit, NoCode>) {
        ifStarted { c ->
            c.stop()
            c.clearMediaItems()         // no record: the service leaves the foreground, the notification goes
        }
        startAt = 0.0
        duration = 0.0
        set(PlaybackState.IDLE)
        reply.resolve()
    }

    override fun status(reply: Reply<Status, NoCode>) {
        reply.resolve(Status(state = state, duration = duration, position = position()))
    }

    override fun positionObserved(observed: Boolean) {
        tick()
        pace()
    }

    override fun close() {
        closed = true
        main.removeCallbacks(ticker)
        ProcessLifecycleOwner.get().lifecycle.removeObserver(this)
        waiting.clear()
        controller?.let { c ->
            c.removeListener(this)
            c.stop()
            c.clearMediaItems()
            c.release()
        }
        controller = null
    }

    private companion object {
        /** How often `position` is sent while the record plays and the app listens. */
        const val TICK_MS = 500L
    }
}
