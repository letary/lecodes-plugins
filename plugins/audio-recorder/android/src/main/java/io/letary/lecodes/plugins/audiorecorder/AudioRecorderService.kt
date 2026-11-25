//
//  AudioRecorderService.kt — lecodes-plugins/audio-recorder
//
//  One recording: the microphone's samples (AudioRecord) on a thread of its own, which
//    - encodes them into a cache .m4a (MediaCodec AAC → MediaMuxer) — not with `file: false`;
//    - says what it hears, `rate` times a second: `level` (the loudest sample since the tick
//      before) and, while the app listens, `pitch` (PitchDetector over the newest window).
//  A pause drops the samples: nothing is encoded, nothing is said, the duration (the samples that
//  were kept) does not grow. The recording ends by the app or by its own limit (`maxDuration`);
//  the file is kept until `stop()` hands it over or `cancel()`. `raw` asks for the unprocessed
//  input (the device's own, else the one of voice recognition: no gain control, no suppression).
//
//  The channel (the calls, the options, the codes) is AudioRecorder.gen.kt, generated from
//  contract.d.ts; a call arrives on the main thread with the microphone permission granted.
//

package io.letary.lecodes.plugins.audiorecorder

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.letary.lecodes.services.PluginFile
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import java.io.File
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

class AudioRecorderService(
    private val context: Context,
    private val events: AudioRecorderEvents,
) : AudioRecorderPlugin {

    private val mainHandler = Handler(Looper.getMainLooper())
    /** The recording under way, or the one that ended and waits for stop(). */
    private var capture: Capture? = null
    /** The recording stopped on its own: what was recorded waits for stop(). */
    private var finished = false

    // ── the calls ────────────────────────────────────────────────────────────

    override fun start(options: RecordOptions?, reply: Reply<Unit, AudioRecorderCode>) {
        if (capture != null) return reply.reject(AudioRecorderCode.BUSY)
        val out = if (options?.file == false) null else File(context.cacheDir, "lecodes-recording-${System.currentTimeMillis()}.m4a")
        val c = try {
            Capture(options, out)
        } catch (e: Exception) {
            out?.delete()
            return reply.reject(AudioRecorderCode.FAILED)
        }
        capture = c
        finished = false
        c.start()
        reply.resolve()
    }

    override fun pause(reply: Reply<Unit, AudioRecorderCode>) {
        val c = capture ?: return reply.reject(AudioRecorderCode.NOT_RECORDING)
        if (finished) return reply.reject(AudioRecorderCode.NOT_RECORDING)
        c.paused = true
        reply.resolve()
    }

    override fun resume(reply: Reply<Unit, AudioRecorderCode>) {
        val c = capture ?: return reply.reject(AudioRecorderCode.NOT_RECORDING)
        if (finished) return reply.reject(AudioRecorderCode.NOT_RECORDING)
        c.paused = false
        reply.resolve()
    }

    override fun stop(reply: Reply<Recording, AudioRecorderCode>) {
        val c = capture ?: return reply.reject(AudioRecorderCode.NOT_RECORDING)
        c.end()
        val seconds = c.seconds
        val out = c.file
        val bytes = if (out != null && c.written && out.exists()) out.readBytes() else ByteArray(0)
        discard()
        if (out == null) return reply.resolve(Recording(file = null, mimeType = "", duration = seconds))
        if (bytes.isEmpty()) return reply.reject(AudioRecorderCode.FAILED)
        reply.resolve(Recording(file = PluginFile(bytes, "recording.m4a"), mimeType = "audio/mp4", duration = seconds))
    }

    override fun cancel(reply: Reply<Unit, AudioRecorderCode>) {
        capture?.end()
        discard()
        reply.resolve()
    }

    /** `pitch` is sent — and looked for — while `events.pitchObserved`: the capture reads it each tick. */
    override fun pitchObserved(observed: Boolean) {}

    override fun close() {
        capture?.end()
        discard()
    }

    // ── plumbing ─────────────────────────────────────────────────────────────

    /** The recording stopped on its own (the capture's thread says so): keep the file, tell the app. */
    private fun finish(c: Capture, reason: EndReason) {
        if (capture !== c || finished) return
        c.end()
        finished = true
        events.ended(reason = reason)
    }

    private fun discard() {
        capture?.file?.delete()
        capture = null
        finished = false
    }

    // ── the capture ──────────────────────────────────────────────────────────

    /** One recording's microphone, encoder and thread. Made and ended on the main thread. */
    @SuppressLint("MissingPermission")   // the glue asked for the microphone before the call
    private inner class Capture(options: RecordOptions?, val file: File?) {
        private val sampleRate = (options?.sampleRate ?: 44100.0).toInt()
        private val record: AudioRecord
        private val encoder: Encoder?
        /** The samples between two ticks of the events. */
        private val tickFrames = max(1, (sampleRate / (options?.rate ?: 10.0).coerceIn(1.0, 50.0)).toInt())
        /** The samples of the limit; 0 = none. */
        private val maxFrames = ((options?.maxDuration ?: 0.0) / 1000.0 * sampleRate).toLong()
        private val thread = Thread({ run() }, "lecodes-audio-recorder")

        @Volatile private var running = true
        @Volatile var paused = false
        /** The samples that were kept (the pauses left out). */
        @Volatile private var frames = 0L
        /** The encoder wrote a file that plays. */
        @Volatile var written = false
            private set

        val seconds: Double get() = frames.toDouble() / sampleRate

        init {
            val minBytes = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            require(minBytes > 0) { "the microphone has no $sampleRate Hz" }
            record = AudioRecord(source(options?.raw == true), sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minBytes * 2, sampleRate / 5 * 2))
            try {
                check(record.state == AudioRecord.STATE_INITIALIZED) { "the microphone did not open" }
                encoder = file?.let { Encoder(it, sampleRate, ((options?.bitrate ?: 64.0) * 1000).toInt()) }
                try {
                    record.startRecording()
                    check(record.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "the microphone did not start" }
                } catch (e: Exception) {
                    encoder?.finish()
                    throw e
                }
            } catch (e: Exception) {
                record.release()
                throw e
            }
        }

        fun start() = thread.start()

        /** Stop the thread and wait for it: the file is complete (or `written` is false) after this. */
        fun end() {
            if (!running) return
            running = false
            runCatching { record.stop() }   // a blocked read returns
            runCatching { thread.join(3000) }
        }

        private fun source(raw: Boolean): Int {
            if (!raw) return MediaRecorder.AudioSource.MIC
            val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            val unprocessed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N &&
                manager?.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
            return if (unprocessed) MediaRecorder.AudioSource.UNPROCESSED else MediaRecorder.AudioSource.VOICE_RECOGNITION
        }

        /** The capture's thread: read, keep (encode, hear), say. Ends by `running`, the limit or a failure. */
        private fun run() {
            val detector = PitchDetector(sampleRate)
            val window = FloatArray(detector.size)           // the newest samples, the last one at the end
            val chunk = ShortArray(min(512, detector.size))
            var peak = 0
            var sinceTick = 0
            var ended: EndReason? = null
            try {
                while (running) {
                    val n = record.read(chunk, 0, chunk.size)
                    if (!running) break
                    if (n < 0) { ended = EndReason.FAILED; break }
                    if (n == 0) continue
                    if (paused) { peak = 0; sinceTick = 0; continue }

                    System.arraycopy(window, n, window, 0, window.size - n)
                    val base = window.size - n
                    for (i in 0 until n) {
                        val s = chunk[i].toInt()
                        val a = abs(s)
                        if (a > peak) peak = a
                        window[base + i] = s / 32768f
                    }
                    encoder?.feed(chunk, n)
                    frames += n

                    sinceTick += n
                    if (sinceTick >= tickFrames) {
                        sinceTick = 0
                        events.level(value = (peak / 32767.0).coerceIn(0.0, 1.0))
                        peak = 0
                        if (events.pitchObserved) {
                            detector.detect(window)
                            events.pitch(frequency = detector.frequency, clarity = detector.clarity)
                        }
                    }
                    if (maxFrames in 1..frames) { ended = EndReason.MAX_DURATION; break }
                }
            } catch (e: Exception) {
                ended = EndReason.FAILED
            }
            runCatching { record.stop() }
            record.release()
            written = encoder?.finish() ?: false
            // The app is told after the file is complete; end() — a join of this thread — returns at once then.
            ended?.let { reason -> mainHandler.post { finish(this, reason) } }
        }
    }

    /** PCM in, an .m4a out: AAC-LC through MediaCodec into MediaMuxer. Fed and finished on one thread. */
    private class Encoder(file: File, private val sampleRate: Int, bitrate: Int) {
        private val codec = MediaCodec.createEncoderByType(MIME)
        private val muxer: MediaMuxer
        private val info = MediaCodec.BufferInfo()
        private var track = -1
        private var muxing = false
        private var wrote = false
        private var frames = 0L

        init {
            val format = MediaFormat.createAudioFormat(MIME, sampleRate, 1)
            format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
            try {
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                codec.start()
            } catch (e: Exception) {
                codec.release()
                throw e
            }
        }

        private val time: Long get() = frames * 1_000_000L / sampleRate

        fun feed(pcm: ShortArray, count: Int) {
            var offset = 0
            while (offset < count) {
                val index = codec.dequeueInputBuffer(10_000)
                if (index >= 0) {
                    val buffer = codec.getInputBuffer(index) ?: throw IllegalStateException("no input buffer")
                    buffer.clear()
                    val shorts = buffer.order(ByteOrder.nativeOrder()).asShortBuffer()
                    val n = min(count - offset, shorts.remaining())
                    shorts.put(pcm, offset, n)
                    codec.queueInputBuffer(index, 0, n * 2, time, 0)
                    frames += n
                    offset += n
                }
                drain(toEnd = false)
            }
        }

        /** End the stream and close the file; false when nothing that plays was written. */
        fun finish(): Boolean {
            val complete = runCatching {
                var index = -1
                var tries = 0
                while (index < 0 && tries++ < 100) {
                    index = codec.dequeueInputBuffer(10_000)
                    if (index < 0) drain(toEnd = false)
                }
                if (index >= 0) {
                    codec.queueInputBuffer(index, 0, 0, time, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                    drain(toEnd = true)
                }
            }.isSuccess
            runCatching { codec.stop() }
            codec.release()
            // A muxer that got no sample throws on stop: such a file does not play.
            val closed = muxing && runCatching { muxer.stop() }.isSuccess
            runCatching { muxer.release() }
            return complete && closed && wrote
        }

        private fun drain(toEnd: Boolean) {
            var idle = 0
            while (true) {
                val index = codec.dequeueOutputBuffer(info, if (toEnd) 10_000 else 0)
                when {
                    index == MediaCodec.INFO_TRY_AGAIN_LATER -> if (!toEnd || ++idle > 300) return
                    index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        track = muxer.addTrack(codec.outputFormat)
                        muxer.start()
                        muxing = true
                    }
                    index >= 0 -> {
                        idle = 0
                        val out = codec.getOutputBuffer(index)
                        val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                        if (out != null && muxing && !config && info.size > 0) {
                            out.position(info.offset)
                            out.limit(info.offset + info.size)
                            muxer.writeSampleData(track, out, info)
                            wrote = true
                        }
                        codec.releaseOutputBuffer(index, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                    }
                }
            }
        }

        private companion object {
            const val MIME = "audio/mp4a-latm"
        }
    }
}
