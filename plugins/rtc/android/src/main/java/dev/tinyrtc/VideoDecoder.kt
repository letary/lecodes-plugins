package dev.tinyrtc

import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max

/** What a view's decoder did. */
data class VideoViewDiagnostics(
    val framesReceived: Long,
    val framesDecoded: Long,
    val framesRendered: Long,
    val framesDropped: Long,
    val decoderErrors: Long,
    val keyframesRequested: Long,
    val width: Int,
    val height: Int,
    val rotation: Int,
    val decoder: String,
)

/**
 * The hardware H.264 decoder of one view showing a remote track, drawing into the view's
 * SurfaceTexture. Configured from the SPS / PPS of the first keyframe, recreated when they change
 * or when it fails; until a keyframe arrives (and after a failure) nothing is shown and keyframes
 * are asked for. Each frame is shown `play_delay_us` after it arrived: it is held here and given
 * to the decoder that much later (less the decoder's own measured latency) — a TextureView shows
 * a buffer as soon as it comes, whatever its timestamp, so the pacing cannot be left to it.
 *
 * Threads: frames come on a core thread and hop to this decoder's own thread ("tinyrtc-decode"),
 * where everything else happens, MediaCodec's callbacks included.
 */
internal class VideoDecoder(
    private val track: RemoteVideoTrack,
    texture: SurfaceTexture,
    private val events: Events,
) : VideoSink {
    interface Events {
        /** The decoder thread: the picture's size (after cropping), before rotation. */
        fun onSize(width: Int, height: Int)

        /** The decoder thread: the rotation of the frames shown changed. */
        fun onRotation(degrees: Int)
    }

    private class Frame(val data: ByteArray, val keyframe: Boolean, val rotation: Int, val showAtNs: Long)

    private val thread = HandlerThread("tinyrtc-decode").apply { start() }
    private val handler = Handler(thread.looper)
    private val surface = Surface(texture)

    // the decoder thread
    private var codec: MediaCodec? = null
    @Volatile private var codecName = ""
    private var sps: ByteArray? = null
    private var pps: ByteArray? = null
    private var waiting = true
    private val pending = ArrayDeque<Frame>()
    private val inputs = ArrayDeque<Int>()
    private val rotations = HashMap<Long, Int>()
    private val queuedAt = HashMap<Long, Long>()
    private var lastPts = 0L
    private var latencyNs = 15_000_000L
    private var lastAsk = 0L
    @Volatile private var rotation = 0
    private var released = false

    private val received = AtomicLong()
    private val decoded = AtomicLong()
    private val rendered = AtomicLong()
    private val dropped = AtomicLong()
    private val errors = AtomicLong()
    private val asked = AtomicLong()
    @Volatile private var width = 0
    @Volatile private var height = 0

    fun diagnostics() = VideoViewDiagnostics(
        received.get(), decoded.get(), rendered.get(), dropped.get(), errors.get(), asked.get(), width, height,
        rotation, codecName,
    )

    init {
        track.addSink(this)
        handler.post { ask(force = true) } // a view that starts showing a track asks for a keyframe
    }

    override fun onFrame(accessUnit: ByteArray, keyframe: Boolean, rotation: Int, playDelayUs: Long) {
        received.incrementAndGet()
        val showAt = System.nanoTime() + playDelayUs.coerceIn(0, MAX_DELAY_US) * 1000
        handler.post { feed(Frame(accessUnit, keyframe, rotation, showAt)) }
    }

    /** Any thread: stops taking frames; [then] runs (on the decoder thread) once the decoder is gone. */
    fun release(then: () -> Unit) {
        track.removeSink(this)
        val posted = handler.post {
            released = true
            handler.removeCallbacksAndMessages(null)
            releaseCodec()
            surface.release()
            then()
            thread.quitSafely()
        }
        if (!posted) then()
    }

    private fun feed(frame: Frame) {
        if (released) return
        if (frame.keyframe) {
            val (s, p) = H264.parameterSets(frame.data)
            if (s != null && p != null && (codec == null || !s.contentEquals(sps) || !p.contentEquals(pps))) configure(s, p)
            if (codec != null && waiting) {
                waiting = false
                pending.clear()
            }
        }
        if (waiting || codec == null) {
            dropped.incrementAndGet()
            ask()
            return
        }
        if (pending.size >= MAX_PENDING) {
            // The decoder does not keep up: start again from the next keyframe.
            dropped.addAndGet(pending.size + 1L)
            pending.clear()
            waiting = true
            ask(force = true)
            return
        }
        pending.addLast(frame)
        drain()
    }

    private val drainLater = Runnable { drain() }

    private fun drain() {
        val c = codec ?: return
        handler.removeCallbacks(drainLater)
        val now = System.nanoTime()
        while (pending.isNotEmpty()) {
            val frame = pending.first()
            val due = frame.showAtNs - latencyNs
            if (due > now) {
                handler.postDelayed(drainLater, max(1L, (due - now) / 1_000_000))
                return
            }
            val index = inputs.removeFirstOrNull() ?: return // onInputBufferAvailable drains again
            pending.removeFirst()
            try {
                val buffer = c.getInputBuffer(index) ?: continue
                if (frame.data.size > buffer.capacity()) {
                    return fail(IllegalStateException("a frame of ${frame.data.size} bytes, input buffers of ${buffer.capacity()}"))
                }
                buffer.clear()
                buffer.put(frame.data)
                val pts = max(lastPts + 1, frame.showAtNs / 1000)
                lastPts = pts
                rotations[pts] = frame.rotation
                queuedAt[pts] = now
                c.queueInputBuffer(index, 0, frame.data.size, pts, if (frame.keyframe) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
            } catch (e: Exception) {
                return fail(e)
            }
        }
    }

    private val callback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(c: MediaCodec, index: Int) {
            if (c !== codec) return
            inputs.addLast(index)
            drain()
        }

        override fun onOutputBufferAvailable(c: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            if (c !== codec) return
            val now = System.nanoTime()
            val pts = info.presentationTimeUs
            queuedAt.remove(pts)?.let { at -> latencyNs = ((latencyNs * 7 + (now - at)) / 8).coerceIn(0, MAX_LATENCY_NS) }
            val r = rotations.remove(pts)
            if (r != null && r != rotation) {
                rotation = r
                events.onRotation(r)
            }
            decoded.incrementAndGet()
            try {
                c.releaseOutputBuffer(index, pts * 1000) // its time, in the System.nanoTime() base
            } catch (e: IllegalStateException) {
                // released meanwhile
            }
        }

        override fun onError(c: MediaCodec, e: MediaCodec.CodecException) {
            if (c === codec) fail(e)
        }

        override fun onOutputFormatChanged(c: MediaCodec, format: MediaFormat) {
            if (c !== codec) return
            fun int(key: String) = if (format.containsKey(key)) format.getInteger(key) else -1
            val left = int("crop-left")
            val right = int("crop-right")
            val top = int("crop-top")
            val bottom = int("crop-bottom")
            val w = if (left >= 0 && right >= left) right - left + 1 else int(MediaFormat.KEY_WIDTH)
            val h = if (top >= 0 && bottom >= top) bottom - top + 1 else int(MediaFormat.KEY_HEIGHT)
            if (w > 0 && h > 0) size(w, h)
        }
    }

    private fun size(w: Int, h: Int) {
        if (w == width && h == height) return
        width = w
        height = h
        events.onSize(w, h)
    }

    private fun configure(sps: ByteArray, pps: ByteArray) {
        releaseCodec()
        val (w, h) = H264.spsSize(sps) ?: (640 to 480)
        for (lowLatency in listOf(true, false)) {
            if (!lowLatency && Build.VERSION.SDK_INT < 30) break // the first try was already without it
            val c = try {
                MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            } catch (e: Exception) {
                Log.e("no H.264 decoder", e)
                return
            }
            try {
                val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
                    setByteBuffer("csd-0", ByteBuffer.wrap(H264.START_CODE + sps))
                    setByteBuffer("csd-1", ByteBuffer.wrap(H264.START_CODE + pps))
                    setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, max(w * h, 256 * 1024))
                    setInteger(MediaFormat.KEY_PRIORITY, 0) // real time
                    if (lowLatency && Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                }
                c.setCallback(callback, handler)
                c.setOnFrameRenderedListener({ codec, _, _ -> if (codec === this.codec) rendered.incrementAndGet() }, handler)
                c.configure(format, surface, null, 0)
                c.start()
                codec = c
                codecName = c.name
                this.sps = sps
                this.pps = pps
                inputs.clear()
                rotations.clear()
                queuedAt.clear()
                Log.i("decoder ${c.name} ${w}x$h${if (lowLatency && Build.VERSION.SDK_INT >= 30) " low-latency" else ""}")
                size(w, h)
                return
            } catch (e: Exception) {
                Log.w("decoder configure (low latency: $lowLatency)", e)
                c.release()
            }
        }
    }

    private fun fail(e: Exception) {
        errors.incrementAndGet()
        Log.w("decoder failed: start again from a keyframe", e)
        releaseCodec()
        sps = null
        pps = null
        pending.clear()
        waiting = true
        ask(force = true)
    }

    private fun releaseCodec() {
        val c = codec ?: return
        codec = null
        inputs.clear()
        runCatching { c.stop() }
        runCatching { c.release() }
    }

    private fun ask(force: Boolean = false) {
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastAsk < ASK_EVERY_MS) return
        lastAsk = now
        asked.incrementAndGet()
        track.requestKeyframe()
    }

    private companion object {
        const val MAX_PENDING = 60
        const val MAX_DELAY_US = 1_000_000L
        const val MAX_LATENCY_NS = 200_000_000L
        const val ASK_EVERY_MS = 500L
    }
}
