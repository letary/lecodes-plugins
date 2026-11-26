package dev.tinyrtc

import java.util.concurrent.CopyOnWriteArrayList

enum class MediaKind { AUDIO, VIDEO }

/** What a connection sends: [RtcConnection.setTrack]. */
sealed interface LocalTrack {
    val kind: MediaKind

    /** false = every connection stops sending it (the other side sees remoteMedia inactive); nothing is freed. */
    var isEnabled: Boolean
    val isStopped: Boolean

    /** Releases the device. Idempotent; no event of the track arrives after it returns. */
    fun stop()
}

/** A track an [RtcVideoView] can show: a [LocalVideoTrack] (the camera's preview) or a [RemoteVideoTrack]. */
sealed interface VideoTrack

/**
 * The microphone's share of the audio unit. It holds nothing itself: the microphone runs while at
 * least one connection sends an enabled, live microphone track.
 */
class LocalAudioTrack internal constructor(private val engine: RtcEngine) : LocalTrack {
    override val kind: MediaKind get() = MediaKind.AUDIO

    override var isEnabled: Boolean = true
        set(value) {
            Core.checkMain("isEnabled")
            if (field == value) return
            field = value
            engine.tracksChanged()
        }

    override var isStopped: Boolean = false
        private set

    /** Main thread: the OS took the microphone for good (it could not be opened, or it died). */
    var onEnded: ((reason: String) -> Unit)? = null

    override fun stop() {
        Core.checkMain("stop")
        if (isStopped) return
        isStopped = true
        engine.tracksChanged()
    }

    internal fun endedByOs(reason: String) {
        if (isStopped) return
        val ended = onEnded
        stop()
        ended?.invoke(reason)
    }
}

/** What one peer sends of sound. It exists from the connection's creation. */
class RemoteAudioTrack internal constructor(private val connection: RtcConnection) {
    /** true = left out of the mix (it still arrives). */
    var isMuted: Boolean = false
        set(value) {
            Core.checkMain("isMuted")
            if (field == value) return
            field = value
            connection.tell { Native.mutePlayout(it, value) }
        }

    /** Whether the other side sends sound now (the remoteMedia event). */
    var isActive: Boolean = false
        internal set
}

/**
 * What one peer sends of video. It exists from the connection's creation; it is decoded only
 * while a view shows it (each view decodes on its own).
 */
class RemoteVideoTrack internal constructor(internal val connection: RtcConnection) : VideoTrack {
    /** Whether the other side sends video now (the remoteMedia event). */
    var isActive: Boolean = false
        internal set

    private val sinks = CopyOnWriteArrayList<VideoSink>()

    internal fun addSink(sink: VideoSink) {
        sinks += sink
    }

    internal fun removeSink(sink: VideoSink) {
        sinks -= sink
    }

    /** A core thread: one access unit, already copied (Annex B). */
    internal fun onFrame(accessUnit: ByteArray, keyframe: Boolean, rotation: Int, playDelayUs: Long) {
        for (sink in sinks) sink.onFrame(accessUnit, keyframe, rotation, playDelayUs)
    }

    /** Any thread. Rate-limited by the core too. */
    internal fun requestKeyframe() = connection.tell { Native.requestKeyframe(it) }
}

internal interface VideoSink {
    /** A core thread: copy nothing more, hop, return. */
    fun onFrame(accessUnit: ByteArray, keyframe: Boolean, rotation: Int, playDelayUs: Long)
}
