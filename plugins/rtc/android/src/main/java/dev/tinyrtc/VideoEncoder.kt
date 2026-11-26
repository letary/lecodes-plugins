package dev.tinyrtc

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecInfo.CodecCapabilities
import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaCodecInfo.EncoderCapabilities
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.view.Surface
import java.nio.ByteBuffer

/**
 * The hardware H.264 encoder of one camera size, fed through its input Surface (the camera
 * session draws into it). The profile: Constrained Baseline (no B-frames), the level the size
 * needs (3.1 for 720p30), real-time priority, CBR where the encoder has it, the bitrate changed on
 * the fly, an IDR on demand. Its callbacks run on [handler] (the camera's thread).
 */
internal class VideoEncoder private constructor(private val listener: Listener) {
    interface Listener {
        /** The parameter sets (SPS + PPS, Annex B): kept for keyframes that come without them. */
        fun onConfig(encoder: VideoEncoder, parameterSets: ByteArray)

        /** One access unit, Annex B, in [buffer] at info.offset (valid until this returns). */
        fun onFrame(encoder: VideoEncoder, buffer: ByteBuffer, info: MediaCodec.BufferInfo)

        fun onError(encoder: VideoEncoder, error: Exception)
    }

    lateinit var codec: MediaCodec
        private set
    lateinit var surface: Surface
        private set
    var name: String = ""
        private set
    var width = 0
        private set
    var height = 0
        private set

    private val callback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {} // Surface input

        override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            try {
                val buffer = codec.getOutputBuffer(index)
                if (buffer != null && info.size > 0) {
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        listener.onConfig(this@VideoEncoder, copy(buffer, info.offset, info.size))
                    } else {
                        listener.onFrame(this@VideoEncoder, buffer, info)
                    }
                }
                codec.releaseOutputBuffer(index, false)
            } catch (e: IllegalStateException) {
                // released meanwhile
            }
        }

        override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) = listener.onError(this@VideoEncoder, e)

        override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
            // Some encoders give the parameter sets here rather than in a config buffer.
            val sps = format.getByteBuffer("csd-0")
            val pps = format.getByteBuffer("csd-1")
            if (sps != null && pps != null) {
                listener.onConfig(this@VideoEncoder, copy(sps, sps.position(), sps.remaining()) + copy(pps, pps.position(), pps.remaining()))
            }
        }
    }

    fun setBitrate(bps: Int) = parameters { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps) }

    fun requestKeyframe() = parameters { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }

    fun release() {
        runCatching { codec.stop() }
        runCatching { codec.release() }
        surface.release()
    }

    private inline fun parameters(fill: Bundle.() -> Unit) {
        try {
            codec.setParameters(Bundle().apply(fill))
        } catch (e: IllegalStateException) {
            // released meanwhile
        }
    }

    private fun open(width: Int, height: Int, fps: Int, bitrate: Int, handler: Handler) {
        val info = encoderInfo() ?: throw RtcError.Failed("no H.264 encoder with Surface input")
        val caps = info.getCapabilitiesForType(MIME)
        val profile = if (caps.profileLevels.any { it.profile == CONSTRAINED_BASELINE }) CONSTRAINED_BASELINE
        else CodecProfileLevel.AVCProfileBaseline
        val cbr = caps.encoderCapabilities?.isBitrateModeSupported(EncoderCapabilities.BITRATE_MODE_CBR) == true

        fun format(full: Boolean) = MediaFormat.createVideoFormat(MIME, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            // Keyframes come when a receiver asks (the core forwards it); this is only a floor.
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10)
            if (cbr) setInteger(MediaFormat.KEY_BITRATE_MODE, EncoderCapabilities.BITRATE_MODE_CBR)
            if (full) {
                setInteger(MediaFormat.KEY_PROFILE, profile)
                setInteger(MediaFormat.KEY_LEVEL, levelFor(width, height, fps))
                setInteger(MediaFormat.KEY_PRIORITY, 0) // real time
                if (Build.VERSION.SDK_INT >= 26) setInteger(MediaFormat.KEY_LATENCY, 1)
                if (Build.VERSION.SDK_INT >= 29) {
                    setInteger(MediaFormat.KEY_PREPEND_HEADER_TO_SYNC_FRAMES, 1)
                    setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
                }
            }
        }

        var failure: Exception? = null
        for (full in listOf(true, false)) {
            val candidate = MediaCodec.createByCodecName(info.name)
            try {
                candidate.setCallback(callback, handler)
                candidate.configure(format(full), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                surface = candidate.createInputSurface()
                candidate.start()
                codec = candidate
                name = info.name
                this.width = width
                this.height = height
                Log.i("encoder ${info.name} ${width}x$height ${fps}fps ${bitrate}bps profile 0x${profile.toString(16)}" +
                    " cbr=$cbr${if (full) "" else " (minimal format)"}")
                return
            } catch (e: Exception) {
                failure = e
                candidate.release()
            }
        }
        throw RtcError.Failed("encoder ${info.name} ${width}x$height: ${failure?.message}")
    }

    companion object {
        private const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
        /** CodecProfileLevel.AVCProfileConstrainedBaseline (API 27). */
        private const val CONSTRAINED_BASELINE = 0x10000

        fun open(width: Int, height: Int, fps: Int, bitrate: Int, handler: Handler, listener: Listener): VideoEncoder =
            VideoEncoder(listener).apply { open(width, height, fps, bitrate, handler) }

        /** The encoder can take this size. */
        fun supports(width: Int, height: Int): Boolean {
            val info = encoderInfo() ?: return false
            return info.getCapabilitiesForType(MIME).videoCapabilities?.isSizeSupported(width, height) != false
        }

        private val chosen: MediaCodecInfo? by lazy {
            val all = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { info ->
                info.isEncoder && info.supportedTypes.any { it.equals(MIME, ignoreCase = true) } &&
                    info.getCapabilitiesForType(MIME).colorFormats.contains(CodecCapabilities.COLOR_FormatSurface)
            }
            all.firstOrNull { isHardware(it) } ?: all.firstOrNull()
        }

        private fun encoderInfo() = chosen

        private fun isHardware(info: MediaCodecInfo): Boolean =
            if (Build.VERSION.SDK_INT >= 29) info.isHardwareAccelerated && !info.isSoftwareOnly
            else !info.name.startsWith("OMX.google.") && !info.name.startsWith("c2.android.")

        /** H.264 table A-1: the lowest level the size and rate fit. */
        private fun levelFor(width: Int, height: Int, fps: Int): Int {
            val frame = ((width + 15) / 16) * ((height + 15) / 16)
            val rate = frame * fps
            return when {
                frame <= 1620 && rate <= 40_500 -> CodecProfileLevel.AVCLevel3
                frame <= 3600 && rate <= 108_000 -> CodecProfileLevel.AVCLevel31
                frame <= 5120 && rate <= 216_000 -> CodecProfileLevel.AVCLevel32
                frame <= 8192 && rate <= 245_760 -> CodecProfileLevel.AVCLevel4
                else -> CodecProfileLevel.AVCLevel41
            }
        }

        private fun copy(buffer: ByteBuffer, offset: Int, size: Int): ByteArray {
            val out = ByteArray(size)
            for (i in 0 until size) out[i] = buffer.get(offset + i)
            return out
        }
    }
}
