//
//  LeCodesRtcPlugin.kt — lecodes-plugins/rtc
//
//  The "rtcMedia" service (the devices: RtcMediaService.kt), the "rtcConnection" service (a session
//  per peer: RtcConnectionSession.kt) and the picture of a track on its two surfaces — the
//  "rtcVideo" view (fullscreen) and the "rtcVideo" host node (a box of a screen's layout), one
//  picture class under both (RtcPicture.kt) — over tinyrtc, whose Kotlin half is vendored beside
//  this one (dev.tinyrtc, hash-locked by ../tinyrtc.lock.json: never edited here). The channels —
//  the calls, their arguments, the props, the events — are RtcMediaPlugin.gen.kt, generated from
//  ../../contract.d.ts.
//
//  What the channels share (RtcShared): tinyrtc's engine, started on the first call that needs it
//  (it opens the core's context, the network and device watches — never at registration), and the
//  registry of the tracks by id (RtcTracks.kt). Signaling is the app's: nothing here knows a room
//  or a server.
//
//  tinyrtc's API is `suspend`: each session runs its waiting calls in a main-thread scope of its
//  own (SessionCalls), cancelled when the session closes — a call still in flight then is rejected
//  at once, so every reply is settled and nothing waits on a session that is gone.
//

package io.letary.lecodes.plugins.rtc

import android.content.Context
import dev.tinyrtc.RtcEngine
import dev.tinyrtc.RtcError
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.services.PluginCode
import io.letary.lecodes.services.Reply
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

object LeCodesRtcPlugin {

    const val PLUGIN_ID = "rtc"

    fun register(engine: LecodesEngine, context: Context) {
        val shared = RtcShared(engine, context.applicationContext)
        RtcMediaChannel.register(engine) { _, events -> RtcMediaService(shared, events) }
        RtcConnectionChannel.register(engine) { params, events -> RtcConnectionSession(shared, params, events) }
        RtcVideoChannel.register(engine) { params, events -> RtcVideoViewInstance(shared, params, events) }
        UIRTCVideoNodeGlue.register(engine) { events -> RtcVideoNodeInstance(shared, events) }
    }
}

/** What the channels of one LecodesEngine share. Main thread. */
internal class RtcShared(val host: LecodesEngine, val context: Context) {

    val tracks = RtcTracks()

    /** tinyrtc's engine once a call started it; null before. */
    var engineIfStarted: RtcEngine? = null
        private set

    /** tinyrtc's engine (one per process), started here on the first call that needs it. A device
     *  without its native library (an x86 emulator) fails the call, never the app. */
    fun rtc(): RtcEngine {
        engineIfStarted?.let { return it }
        val made = try {
            RtcEngine.getInstance(context)
        } catch (t: Throwable) {
            throw RtcError.Failed("tinyrtc did not start: $t")
        }
        engineIfStarted = made
        return made
    }
}

/**
 * The calls of one session: each reply settled exactly once. [launch] runs a call that waits on
 * tinyrtc in the session's main-thread scope; [now] one that does not. [close] cancels the scope and
 * rejects what is still in flight with [closedCode]; a call after it is rejected the same way.
 * tinyrtc's errors become the session's codes through [codeOf]; anything else (a bug) is a message.
 */
internal class SessionCalls<C : PluginCode>(private val closedCode: C, private val codeOf: (RtcError) -> C) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val pending = HashSet<Reply<*, C>>()

    var isClosed = false
        private set

    fun <V> launch(reply: Reply<V, C>, block: suspend () -> V) {
        if (isClosed) return reply.reject(closedCode)
        pending += reply
        scope.launch {
            val outcome = try {
                Result.success(block())
            } catch (e: CancellationException) {
                throw e // the session closed: close() settled the reply
            } catch (t: Throwable) {
                Result.failure(t)
            }
            if (pending.remove(reply)) settle(reply, outcome)
        }
    }

    fun <V> now(reply: Reply<V, C>, block: () -> V) {
        if (isClosed) return reply.reject(closedCode)
        val outcome = try {
            Result.success(block())
        } catch (t: Throwable) {
            Result.failure(t)
        }
        settle(reply, outcome)
    }

    fun close() {
        if (isClosed) return
        isClosed = true
        scope.cancel()
        val left = pending.toList()
        pending.clear()
        for (reply in left) reply.reject(closedCode)
    }

    private fun <V> settle(reply: Reply<V, C>, outcome: Result<V>) {
        outcome.fold(
            onSuccess = { reply.resolve(it) },
            onFailure = { e -> if (e is RtcError) reply.reject(codeOf(e)) else reply.fail("rtc: $e") },
        )
    }
}
