package dev.tinyrtc

import java.nio.ByteBuffer

/**
 * The C face (core/include/tinyrtc.h) as libtinyrtc_jni.so registers it, and the three dispatchers
 * its callbacks call. Handles are `Long`s (0 = none); text is UTF-8 in byte arrays both ways; a
 * status is the header's (0 = OK, < 0 = an error, see [errorOf]).
 *
 * The dispatchers run on core threads (and, for a source, sometimes on the thread that called
 * [sendVideo] or [sourceSetLimits]): they find the object by its key, hand over what was copied,
 * and return. Nothing here is called from inside one of them.
 */
internal object Native {
    init {
        System.loadLibrary("tinyrtc_jni")
    }

    @JvmStatic external fun abiVersion(): Int

    @JvmStatic external fun contextCreate(logLevel: Int): Long
    @JvmStatic external fun contextDestroy(context: Long)
    @JvmStatic external fun networkChanged(context: Long)

    /** [pcm]: a direct buffer of int16 samples, native order. */
    @JvmStatic external fun audioPush(context: Long, pcm: ByteBuffer, frames: Int)
    @JvmStatic external fun audioPull(context: Long, pcm: ByteBuffer, frames: Int)

    @JvmStatic external fun sourceCreate(context: Long, key: Int): Long
    @JvmStatic external fun sourceDestroy(source: Long)
    @JvmStatic external fun sourceSetLimits(source: Long, bitrate: Int, fps: Int, height: Int)
    /** [frame]: a direct buffer (a MediaCodec output buffer), Annex B. */
    @JvmStatic external fun sourceSend(
        source: Long, frame: ByteBuffer, offset: Int, length: Int, captureTimeUs: Long, keyframe: Boolean, rotation: Int,
    )

    @JvmStatic external fun connectionCreate(
        context: Long, key: Int, urls: Array<ByteArray>?, usernames: Array<ByteArray?>?, credentials: Array<ByteArray?>?,
        relayOnly: Boolean,
    ): Long
    /** SYNC: joins the connection's threads. */
    @JvmStatic external fun connectionDestroy(connection: Long)
    /** SYNC. */
    @JvmStatic external fun offer(connection: Long, iceRestart: Boolean, status: IntArray): ByteArray?
    /** SYNC. */
    @JvmStatic external fun acceptOffer(connection: Long, offer: ByteArray, status: IntArray): ByteArray?
    /** SYNC. */
    @JvmStatic external fun acceptAnswer(connection: Long, answer: ByteArray): Int
    @JvmStatic external fun addCandidate(connection: Long, candidate: ByteArray?): Int
    @JvmStatic external fun sendAudio(connection: Long, on: Boolean)
    @JvmStatic external fun sendVideo(connection: Long, source: Long)
    @JvmStatic external fun mutePlayout(connection: Long, muted: Boolean)
    @JvmStatic external fun requestKeyframe(connection: Long)

    /** SYNC. The id (>= 0) or a status (< 0). */
    @JvmStatic external fun channelOpen(
        connection: Long, label: ByteArray, unordered: Boolean, maxRetransmits: Int, maxPacketLifeMs: Int,
    ): Long
    /** Waits for the connection's thread (the header does not mark it SYNC; the core's code does wait). */
    @JvmStatic external fun channelSend(connection: Long, id: Int, data: ByteArray, binary: Boolean): Int
    /** SYNC. Bytes (>= 0) or a status (< 0). */
    @JvmStatic external fun channelBuffered(connection: Long, id: Int): Long
    @JvmStatic external fun channelSetBufferedLow(connection: Long, id: Int, threshold: Long): Int
    @JvmStatic external fun channelClose(connection: Long, id: Int): Int
    /** SYNC. [out]: the 16 fields of tinyrtc_stats in the header's order. */
    @JvmStatic external fun stats(connection: Long, out: DoubleArray): Int

    // ---- the dispatchers (core threads) ----

    const val EVENT_STATE = 1
    const val EVENT_LOCAL_CANDIDATE = 2
    const val EVENT_ICE_RESTART_NEEDED = 3
    const val EVENT_REMOTE_MEDIA = 4
    const val EVENT_VIDEO_FRAME = 5
    const val EVENT_CHANNEL_OPEN = 6
    const val EVENT_CHANNEL_MESSAGE = 7
    const val EVENT_CHANNEL_BUFFERED_LOW = 8
    const val EVENT_CHANNEL_CLOSED = 9

    /**
     * One event of a connection. [a], [b], [c], [bytes] by [type]: state (a); candidate (bytes);
     * remote media (a = media, b = active); video frame (a = rotation | keyframe << 16,
     * b = rtp timestamp, c = play delay µs, bytes = the access unit, Annex B); channel open
     * (a = id, bytes = label); message (a = id, b = binary, bytes); buffered low / closed (a = id).
     */
    @JvmStatic
    fun onConnectionEvent(key: Int, type: Int, a: Int, b: Int, c: Long, bytes: ByteArray?) {
        try {
            Registry.get<RtcConnection>(key)?.onCoreEvent(type, a, b, c, bytes)
        } catch (t: Throwable) {
            Log.e("connection event $type", t)
        }
    }

    @JvmStatic
    fun onSourceTarget(key: Int, bitrate: Int, fps: Int, height: Int) {
        try {
            Registry.get<CameraPipeline>(key)?.onTarget(bitrate, fps, height)
        } catch (t: Throwable) {
            Log.e("source target", t)
        }
    }

    @JvmStatic
    fun onSourceKeyframe(key: Int) {
        try {
            Registry.get<CameraPipeline>(key)?.onKeyframeRequested()
        } catch (t: Throwable) {
            Log.e("source keyframe", t)
        }
    }
}
