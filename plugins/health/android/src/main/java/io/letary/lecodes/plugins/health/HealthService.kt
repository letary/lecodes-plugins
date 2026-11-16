//
//  HealthService.kt — lecodes-plugins/health
//
//  One session of the "health" service: the contract's HealthPlugin (Health.gen.kt reads the calls
//  off the wire) over Health Connect (HealthConnectStore: the client, the type table, the totals).
//
//  Health Connect's calls are suspend functions. They run on the standard library's coroutines
//  (`launch`): no scope, no dispatcher and no dependency of the plugin's own — the client brings
//  kotlinx.coroutines with it at run time. A call's outcome comes back to the main thread, where the
//  calls arrive and the state lives.
//
//  The permissions are Health Connect's own, per type (android.permission.health.READ_*, the
//  manifest's), asked through its sheet — PermissionController's activity result contract, launched
//  on the host's activity through its ActivityResultRegistry (registered for one sheet, unregistered
//  after it, so a sheet can come at any time). One sheet at a time: a request while one is up is
//  asked after it, what that one granted counted. request() does not report the answer; sum() does:
//  a query of a type not granted throws SecurityException, and the granted permissions tell it from
//  one refused for another reason (a read in the background) — `denied` / `failed`.
//
//  Health Connect's library is minSdk 26 (the app allows it below, its manifest): below API 26 the
//  store is never made and every call answers "unavailable".
//

package io.letary.lecodes.plugins.health

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.lifecycle.Lifecycle
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import java.lang.ref.WeakReference
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine

class HealthService(
    private val engine: LecodesEngine,
    context: Context,
) : HealthPlugin {
    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())

    /** Health Connect, made the first time it is there (getOrCreate throws where it is not). */
    private var store: HealthConnectStore? = null

    // ── calls ────────────────────────────────────────────────────────────────

    override fun available(reply: Reply<Boolean, HealthCode>) {
        reply.resolve(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && HealthConnectStore.available(appContext))
    }

    override fun request(types: List<HealthType>, reply: Reply<Unit, HealthCode>) {
        val store = connect() ?: return reply.reject(HealthCode.UNAVAILABLE)
        val wanted = types.map { store.permission(it) }.toSet()
        if (wanted.isEmpty()) return reply.resolve()
        if (asking != null) return queue(types, reply)
        launch({ store.granted() }) { result ->
            val granted = result.getOrElse { e ->
                Log.w(TAG, "[health] the granted permissions could not be read: $e")
                return@launch reply.reject(HealthCode.FAILED)
            }
            // Nothing to ask: no sheet (Health Connect would show one with every switch on).
            val missing = wanted - granted
            if (missing.isEmpty()) return@launch reply.resolve()
            if (asking != null) return@launch queue(types, reply)   // one came up meanwhile
            show(store, missing, reply)
        }
    }

    override fun sum(type: HealthType, range: HealthRange, reply: Reply<List<HealthTotal>, HealthCode>) {
        // The wrapper refuses these before the wire; a call from elsewhere is said the same.
        if (!(range.from < range.to)) return reply.fail("Health.sum: range.from must be before range.to")
        val length = when (range.bucket) {
            HealthBucket.HOUR -> HOUR_MS
            HealthBucket.DAY -> DAY_MS
            null -> null
        }
        if (length != null && Math.ceil((range.to - range.from) / length) > MAX_BUCKETS) {
            return reply.fail("Health.sum: more than $MAX_BUCKETS buckets — a shorter range or a longer bucket")
        }
        val store = connect() ?: return reply.reject(HealthCode.UNAVAILABLE)
        launch({ store.sum(type, range) }) { result ->
            result.fold(onSuccess = { reply.resolve(it) }, onFailure = { failed(store, type, it, reply) })
        }
    }

    override fun close() {
        // The sheet stays up (it is Health Connect's): its answer finds no one. The calls waiting for
        // it resolve — request() never says what was chosen.
        val queued = waiting.toList()
        waiting.clear()
        if (asking != null) settle(true)
        for ((_, reply) in queued) reply.resolve()
    }

    // ── the answer of a query ───────────────────────────────────────────────

    /** A query that threw. SecurityException: reading the type is not granted — or it is, and the
     *  store refused for another reason (a read in the background): the granted permissions say. */
    private fun failed(store: HealthConnectStore, type: HealthType, e: Throwable, reply: Reply<List<HealthTotal>, HealthCode>) {
        if (e !is SecurityException) {
            Log.w(TAG, "[health] sum failed: $e")
            return reply.reject(HealthCode.FAILED)
        }
        launch({ store.granted() }) { granted ->
            if (granted.getOrNull()?.contains(store.permission(type)) == false) {
                reply.reject(HealthCode.DENIED)
            } else {
                Log.w(TAG, "[health] sum refused: $e")
                reply.reject(HealthCode.FAILED)
            }
        }
    }

    // ── the sheet ────────────────────────────────────────────────────────────

    /** The request whose sheet is up, and those asked while it is. */
    private var asking: Reply<Unit, HealthCode>? = null
    private val waiting = ArrayDeque<Pair<List<HealthType>, Reply<Unit, HealthCode>>>()
    private var launcher: ActivityResultLauncher<Set<String>>? = null

    /** The key of the sheet's result in the activity's registry: this session's, so that an activity
     *  made again by a turn of the screen hands the result to the same registration (`lifecycle`). */
    private val key = "io.letary.lecodes.plugins.health.request#${System.identityHashCode(this)}"

    private fun queue(types: List<HealthType>, reply: Reply<Unit, HealthCode>) {
        waiting.addLast(types to reply)
    }

    private fun show(store: HealthConnectStore, permissions: Set<String>, reply: Reply<Unit, HealthCode>) {
        val activity = engine.getActivity()
        // An activity in the background starts none (Android's background-start rules): the sheet
        // would never come and the call would wait for ever.
        if (activity == null || activity.isFinishing || activity.isDestroyed || !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            return reply.reject(HealthCode.FAILED)
        }
        asking = reply
        host = WeakReference(activity)
        hostClass = activity.javaClass
        turning = false
        (appContext as Application).registerActivityLifecycleCallbacks(lifecycle)
        try {
            register(activity, store).launch(permissions)
        } catch (e: Exception) {
            Log.w(TAG, "[health] the sheet did not start: $e")
            settle(false)
        }
    }

    /** The registration of the sheet's result on `activity`'s registry, under the session's key. */
    private fun register(activity: ComponentActivity, store: HealthConnectStore): ActivityResultLauncher<Set<String>> =
        activity.activityResultRegistry.register(key, store.sheet) { settle(true) }.also { launcher = it }

    /** The sheet is done (`shown`: it came up; what it granted is sum()'s to tell), or never came. */
    private fun settle(shown: Boolean) {
        val reply = asking ?: return
        asking = null
        launcher?.unregister()
        launcher = null
        host = null
        hostClass = null
        turning = false
        (appContext as Application).unregisterActivityLifecycleCallbacks(lifecycle)
        if (shown) reply.resolve() else reply.reject(HealthCode.FAILED)
        // The next request asks again: what this sheet granted is no longer missing.
        val (types, next) = waiting.removeFirstOrNull() ?: return
        request(types, next)
    }

    /**
     * The activity the sheet was launched from. A turn of the screen makes it again (also while the
     * sheet is in front, on the way back): the result goes to the new activity's registry, under the
     * key the old one saved — registered there again, it reaches `settle`. The next activity of the
     * host's class created is that one. Destroyed for good, it takes the result with it: the call
     * resolves, else it would wait for ever.
     */
    private var host: WeakReference<Activity>? = null
    private var hostClass: Class<*>? = null
    private var turning = false

    private val lifecycle = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
            if (!turning || activity.javaClass != hostClass) return
            turning = false
            host = WeakReference(activity)
            val made = store
            if (activity !is ComponentActivity || made == null) return settle(true)
            register(activity, made)
        }
        override fun onActivityDestroyed(activity: Activity) {
            if (activity !== host?.get()) return
            if (activity.isChangingConfigurations) { turning = true; return }
            settle(true)
        }
        override fun onActivityStarted(activity: Activity) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivityStopped(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    }

    // ── plumbing ─────────────────────────────────────────────────────────────

    /** Health Connect, where it is there now. */
    private fun connect(): HealthConnectStore? {
        store?.let { return it }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !HealthConnectStore.available(appContext)) return null
        return try {
            HealthConnectStore(appContext).also { store = it }
        } catch (e: Exception) {
            Log.w(TAG, "[health] Health Connect's client could not be made: $e")
            null
        }
    }

    /** Run a suspend call of Health Connect; its outcome goes to [done] on the main thread. The call
     *  starts here and goes on wherever the client resumes it. Not cancelled by close(): a reply
     *  settled after the session is gone is dropped by the channel. */
    private fun <T> launch(block: suspend () -> T, done: (Result<T>) -> Unit) {
        block.startCoroutine(Continuation(EmptyCoroutineContext) { result -> main.post { done(result) } })
    }

    companion object {
        private const val TAG = "LeCodesHealth"
        /** The most rows one sum() answers — the wrapper's MAX_BUCKETS, counted the same way (a day
         *  as 24 hours). */
        private const val MAX_BUCKETS = 10_000
        private const val HOUR_MS = 3_600_000.0
        private const val DAY_MS = 86_400_000.0
    }
}
