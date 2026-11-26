package dev.tinyrtc

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicLong

/** What the sound did: frames of 48 kHz mono int16. */
data class AudioDiagnostics(
    val framesPushed: Long,
    val framesPulled: Long,
    val capturing: Boolean,
    val playing: Boolean,
    val effects: List<String>,
)

/**
 * The microphone and the playout: AudioRecord and AudioTrack, 48 kHz mono int16 both ways, each on
 * a thread of its own moving 10 ms at a time — tinyrtc_audio_push after every read, the core's mix
 * from tinyrtc_audio_pull before every write. The platform's buffers are the clock.
 *
 * What runs is decided by the engine ([update]); starting and stopping happen on this class's own
 * thread ("tinyrtc-audio"), never on the main thread, together with the AudioSession's activation.
 */
internal class AudioDevice(private val engine: RtcEngine) {
    private val session get() = engine.audioSession
    private val handler = Handler(HandlerThread("tinyrtc-audio").apply { start() }.looper)

    // the audio thread
    private var active = false
    private var capture: Worker? = null
    private var playout: Worker? = null

    private val pushed = AtomicLong()
    private val pulled = AtomicLong()
    @Volatile private var effectNames: List<String> = emptyList()

    fun diagnostics() = AudioDiagnostics(
        pushed.get(), pulled.get(), capture?.isAlive == true, playout?.isAlive == true, effectNames,
    )

    /** Main thread: what should run now. */
    fun update(capture: Boolean, playout: Boolean) {
        handler.post { apply(capture, playout) }
    }

    fun reroute() {
        handler.post { if (active) session.route() }
    }

    private fun apply(wantCapture: Boolean, wantPlayout: Boolean) {
        val want = wantCapture || wantPlayout
        if (want && !active) {
            active = true
            session.activate()
        }
        if (wantCapture) {
            if (capture == null) capture = Worker("tinyrtc-mic", ::captureLoop).also { it.start() }
        } else {
            capture?.finish()
            capture = null
        }
        if (wantPlayout) {
            if (playout == null) playout = Worker("tinyrtc-playout", ::playoutLoop).also { it.start() }
        } else {
            playout?.finish()
            playout = null
        }
        if (!want && active) {
            active = false
            session.deactivate()
        }
    }

    private class Worker(name: String, private val body: (Worker) -> Unit) : Thread(name) {
        @Volatile var running = true

        override fun run() {
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
            try {
                body(this)
            } catch (t: Throwable) {
                Log.e("$name died", t)
            }
        }

        fun finish() {
            running = false
            join(1000)
        }
    }

    @SuppressLint("MissingPermission") // checked here and in openMicrophone
    private fun captureLoop(worker: Worker) {
        if (engine.app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return failed("the microphone permission is gone")
        }
        val minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minimum <= 0) return failed("no 48 kHz mono capture on this device ($minimum)")
        val record = try {
            AudioRecord(session.recordSource, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minimum, CHUNK_BYTES * 4))
        } catch (e: Exception) {
            return failed("the microphone did not open: ${e.message}")
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return failed("the microphone did not open")
        }
        val effects = session.attachEffects(record.audioSessionId)
        effectNames = effects.map { it.descriptor.name }
        val buffer = ByteBuffer.allocateDirect(CHUNK_BYTES).order(ByteOrder.nativeOrder())
        val context = engine.handle
        try {
            record.startRecording()
            if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) return failed("the microphone is taken")
            Log.i("capture: 48 kHz mono, buffer ${maxOf(minimum, CHUNK_BYTES * 4)} bytes, effects $effectNames")
            while (worker.running) {
                val read = record.read(buffer, CHUNK_BYTES)
                if (read > 0) {
                    Native.audioPush(context, buffer, read / 2)
                    pushed.addAndGet(read / 2L)
                } else if (read < 0) {
                    return failed("the microphone stopped ($read)")
                }
            }
        } finally {
            runCatching { record.stop() }
            effects.forEach { runCatching { it.release() } }
            record.release()
        }
    }

    private fun playoutLoop(worker: Worker) {
        val minimum = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val size = maxOf(minimum, CHUNK_BYTES * 4)
        val track = try {
            AudioTrack.Builder()
                .setAudioAttributes(session.playbackAttributes)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build(),
                )
                .setBufferSizeInBytes(size)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (e: Exception) {
            Log.e("playout did not open", e)
            return
        }
        if (track.state != AudioTrack.STATE_INITIALIZED) {
            track.release()
            Log.e("playout did not open")
            return
        }
        val buffer = ByteBuffer.allocateDirect(CHUNK_BYTES).order(ByteOrder.nativeOrder())
        val context = engine.handle
        try {
            track.play()
            Log.i("playout: 48 kHz mono, buffer $size bytes")
            while (worker.running) {
                Native.audioPull(context, buffer, CHUNK_FRAMES)
                buffer.clear() // write() reads from the position and moves it
                val written = track.write(buffer, CHUNK_BYTES, AudioTrack.WRITE_BLOCKING)
                if (written < 0) {
                    Log.e("playout stopped ($written)")
                    return
                }
                pulled.addAndGet(CHUNK_FRAMES.toLong())
            }
        } finally {
            runCatching { track.stop() }
            track.release()
        }
    }

    private fun failed(message: String) {
        Log.e("capture: $message")
        Core.main.post { engine.microphoneFailed(message) }
    }

    private companion object {
        const val RATE = 48_000
        const val CHUNK_FRAMES = 480 // 10 ms
        const val CHUNK_BYTES = CHUNK_FRAMES * 2
    }
}
