package dev.tinyrtc

import android.os.Handler
import android.os.Looper
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher

/**
 * The threads of the half.
 *
 * - main: every public method is called here, every public event is delivered here.
 * - [lane]: ONE thread that makes every call into the core that takes a handle and is not on a hot
 *   path — creating and destroying handles, the SYNC calls (offer, stats, ...), what a connection
 *   sends. One thread, in order: no handle is ever destroyed while another call is using it, and a
 *   `suspend` call of the API is `withContext(lane)`. The hot paths stay on their own threads:
 *   audio push / pull (the context lives as long as the process), a source's frames (the encoder
 *   thread, under the source's lock), see CameraPipeline.
 */
internal object Core {
    val main = Handler(Looper.getMainLooper())

    val lane = Executors.newSingleThreadExecutor { r -> Thread(r, "tinyrtc-calls").apply { isDaemon = true } }
        .asCoroutineDispatcher()
    val scope = CoroutineScope(SupervisorJob() + lane)

    fun isMain() = Looper.myLooper() == Looper.getMainLooper()

    fun checkMain(what: String) = check(isMain()) { "tinyrtc: $what must be called on the main thread" }
}

/**
 * Objects the core calls back, by the integer key their handle was given as `user`. Weak: an
 * object the app dropped is not kept alive by the core's callbacks (and a late callback finds
 * nothing).
 */
internal object Registry {
    private val next = AtomicInteger(1)
    private val objects = ConcurrentHashMap<Int, WeakReference<Any>>()

    fun add(o: Any): Int {
        val key = next.getAndIncrement()
        objects[key] = WeakReference(o)
        return key
    }

    fun remove(key: Int) {
        objects.remove(key)
    }

    inline fun <reified T> get(key: Int): T? = objects[key]?.get() as? T
}

internal object Log {
    private const val TAG = "tinyrtc"
    fun i(message: String) = android.util.Log.i(TAG, message)
    fun w(message: String, t: Throwable? = null) = android.util.Log.w(TAG, message, t)
    fun e(message: String, t: Throwable? = null) = android.util.Log.e(TAG, message, t)
}

internal const val STATUS_OK = 0

/** The core's status codes as the error type: they never surface as numbers. */
internal fun errorOf(status: Int, what: String): RtcError = when (status) {
    -1 -> RtcError.Closed("$what: closed")
    -2 -> RtcError.Failed("$what: a malformed argument")
    -3 -> RtcError.Failed("$what: not in this state")
    -4 -> RtcError.Failed("$what: the description does not parse, or is outside the profile")
    -5 -> RtcError.NotFound("$what: no such channel")
    -6 -> RtcError.Closed("$what: the connection is closed")
    else -> RtcError.Failed("$what: status $status")
}

internal fun checkStatus(status: Int, what: String) {
    if (status != STATUS_OK) throw errorOf(status, what)
}

internal fun String.utf8(): ByteArray = toByteArray(Charsets.UTF_8)
internal fun ByteArray.utf8(): String = toString(Charsets.UTF_8)
