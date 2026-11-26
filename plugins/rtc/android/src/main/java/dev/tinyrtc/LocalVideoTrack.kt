package dev.tinyrtc

import java.lang.ref.WeakReference

/**
 * The camera: its session, its hardware encoder and the core's video source. One stream, encoded
 * once for every connection that sends it; the core steers the encoder (bitrate, rate, size, an
 * IDR when a receiver lost the picture). An [RtcVideoView] showing it shows the camera's preview —
 * several views at once where the camera shares its preview stream (Android 8+, a camera above
 * LEGACY: as many views as the platform shares a stream with, 4 on current versions); a view past
 * that stays black (logged) and the views before it keep the picture.
 */
class LocalVideoTrack internal constructor(private val engine: RtcEngine, internal val pipe: CameraPipeline) :
    LocalTrack, VideoTrack {

    override val kind: MediaKind get() = MediaKind.VIDEO

    /** What the camera runs at (the closest format it has to what was asked). */
    val settings: VideoSettings get() = pipe.settings

    /** The most this camera's stream may take, bits per second (1 500 000 until set). */
    val maxBitrate: Int get() = pipe.maxBitrate

    /**
     * Sets [maxBitrate]. The size and the rate under it keep following the network by themselves;
     * every connection that sends this track is under the same ceiling (it is encoded once).
     * [RtcError.Failed] for a value <= 0. Returns once the core has it; a cancelled caller stops
     * waiting, the ceiling is applied all the same.
     */
    suspend fun setMaxBitrate(bitsPerSecond: Int) {
        Core.checkMain("setMaxBitrate")
        if (bitsPerSecond <= 0) throw RtcError.Failed("setMaxBitrate: $bitsPerSecond bit/s: the ceiling must be positive")
        pipe.maxBitrate = bitsPerSecond
        pipe.pushLimits().join()
    }

    /** false = no connection sends it (the other side sees remoteMedia inactive); the camera keeps running. */
    override var isEnabled: Boolean = true
        set(value) {
            Core.checkMain("isEnabled")
            if (field == value) return
            field = value
            engine.tracksChanged()
        }

    override var isStopped: Boolean = false
        private set

    /** Main thread: the camera is gone for good (it failed, or could not be reopened). */
    var onEnded: ((reason: String) -> Unit)? = null

    /** Frames encoded and sent, the core's last target, the encoder's size. */
    val diagnostics: VideoTrackDiagnostics get() = pipe.diagnostics()

    init {
        // The pipeline must not keep the track alive (a track the app dropped stops itself).
        val self = WeakReference(this)
        pipe.onEnded = { reason -> self.get()?.endedByOs(reason) }
    }

    /**
     * Another camera, size or rate. The track (and what every connection sends) stays; returns once
     * the camera runs with [options]. No such camera: [RtcError.NotFound], nothing changed. When the
     * camera fails (it does not open, it errors, it takes no session), the track goes back to the
     * camera and format it had and this throws ([RtcError.Failed], or [RtcError.NotFound] /
     * [RtcError.Denied] when that is the cause); when even that camera does not come back, the track
     * ends ([onEnded]) and this throws. A cancelled caller stops waiting; the switch (or the way
     * back) goes on without it.
     */
    suspend fun apply(options: CameraOptions) {
        Core.checkMain("apply")
        if (isStopped) throw RtcError.Closed("apply: the track is stopped")
        pipe.apply(options)
    }

    override fun stop() {
        Core.checkMain("stop")
        if (isStopped) return
        isStopped = true
        engine.tracksChanged() // every connection lets the source go first (on the lane) ...
        pipe.close() // ... then the camera closes and the source is destroyed (on the lane, after)
    }

    private fun endedByOs(reason: String) {
        if (isStopped) return
        val ended = onEnded
        stop()
        ended?.invoke(reason)
    }

    /** Dropped without stop(): no connection or view holds it any more. */
    protected fun finalize() {
        if (!isStopped) pipe.close()
    }
}
