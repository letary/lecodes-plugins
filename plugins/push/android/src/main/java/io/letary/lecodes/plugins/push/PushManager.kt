//
//  PushManager.kt — lecodes-plugins/push
//
//  The Android mirror of the iOS push plugin's PushManager: FCM token + backend registration
//  + payload routing behind the "push" service (docs/push-plan.md).
//
//  Contract notes carried over from the iOS device pass:
//   - register() checks identity BEFORE the permission prompt ("unavailable" beats the dialog).
//   - getStatus() never prompts and works without identity (the SDK pokes the session open with
//     it to establish the event pipe).
//   - Token rotation mints NEW addresses (the backend upsert key is the token) — onNewToken
//     re-registers every persisted project and stores the fresh address.
//

package io.letary.lecodes.plugins.push

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.utils.PermissionRequester
import io.letary.lecodes.utils.Services
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

object PushManager {

    private const val API_BASE = "https://le.codes"
    const val EXTRA_PAYLOAD = "lecodes.push.payload"

    private lateinit var appContext: Context
    var engine: LecodesEngine? = null
        private set

    /** PushPlugin.setForeground (host onResume/onPause) — a banner is suppressed only for a
     *  foregrounded same-project world (the iOS willPresent rule). */
    @Volatile var isForeground = false

    private val sessions = mutableListOf<Services.Channel>()
    private var launchPayload: JSONObject? = null

    // The two backend calls are tiny JSON requests; a dedicated thread keeps them off the main
    // thread without touching the engine's shared OkHttp client (which may not exist yet when a
    // background FCM start reaches this object).
    private val httpExecutor = Executors.newSingleThreadExecutor()

    fun init(context: Context, engine: LecodesEngine) {
        appContext = context.applicationContext
        this.engine = engine
    }

    /** Bootstrap path for FCM service entry points that can run before the host activity did. */
    fun ensureContext(context: Context) {
        if (!this::appContext.isInitialized) appContext = context.applicationContext
    }

    private val prefs: SharedPreferences
        get() = appContext.getSharedPreferences("lecodes.push", Context.MODE_PRIVATE)

    // ── sessions (the "push" service's event pipe) ───────────────────────────

    fun addSession(channel: Services.Channel) = synchronized(sessions) { sessions.add(channel) }
    fun removeSession(channel: Services.Channel) = synchronized(sessions) { sessions.remove(channel) }

    private fun emitToSessions(event: String, payload: JSONObject) {
        val snapshot = synchronized(sessions) { sessions.toList() }
        for (channel in snapshot) channel.emit(event, payload.toString())
    }

    // ── service calls ────────────────────────────────────────────────────────

    fun getStatus(): JSONObject {
        val permission = when {
            Build.VERSION.SDK_INT < 33 ->
                if (notificationsEnabled()) "granted" else "denied"
            ContextCompat.checkSelfPermission(appContext, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED -> if (notificationsEnabled()) "granted" else "denied"
            prefs.getBoolean("permissionRequested", false) -> "denied"
            else -> "prompt"
        }
        val registered = engine?.currentProjectUuid?.let { loadRegistration(it) != null } ?: false
        return JSONObject().put("permission", permission).put("registered", registered)
    }

    fun register(call: Services.ServiceCall, user: String?) {
        // Identity FIRST — an unattributed world must reject before any permission path.
        val uuid = engine?.currentProjectUuid ?: return call.reject("unavailable")
        withPermission(call) {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token ->
                    postRegistration(uuid, user, token) { address, error ->
                        if (address != null) {
                            saveRegistration(uuid, address, user)
                            call.resolve(JSONObject().put("address", address))
                        } else {
                            call.reject(error ?: "unavailable")
                        }
                    }
                }
                .addOnFailureListener { call.reject("unavailable") }
        }
    }

    fun unregister(call: Services.ServiceCall) {
        val uuid = engine?.currentProjectUuid ?: return call.reject("unavailable")
        val entry = loadRegistration(uuid)
        if (entry == null) { call.resolve(); return }
        removeRegistration(uuid)
        // Fire-and-forget like iOS — the raw token is the ownership proof the DELETE carries.
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            httpExecutor.execute {
                runCatching {
                    httpJson("DELETE", "$API_BASE/api/push/registrations/${entry.optString("address")}",
                        JSONObject().put("token", token))
                }
            }
        }
        call.resolve()
    }

    /** The notification that cold-started this world — gated on the CURRENT world's identity so
     *  another project's parked payload never leaks into a different app. */
    fun getLaunch(): JSONObject? {
        val payload = launchPayload ?: return null
        if (payload.optString("projectUuid") != engine?.currentProjectUuid) return null
        return toJsPayload(payload)
    }

    // ── FCM entry points (LePushMessagingService) ────────────────────────────

    /** @return true when handled as a foreground same-project "message" (banner suppressed). */
    fun onMessage(payload: JSONObject): Boolean {
        val e = engine ?: return false
        val uuid = e.currentProjectUuid ?: return false
        if (!isForeground || uuid != payload.optString("projectUuid")) return false
        emitToSessions("message", toJsPayload(payload))
        return true
    }

    fun onNewToken(token: String) {
        val regs = loadRegistrations()
        for (uuid in regs.keys()) {
            val entry = regs.optJSONObject(uuid) ?: continue
            val user = entry.optString("user").takeIf { it.isNotEmpty() }
            // Rotation mints a new address (backend upsert key is the token) — store the fresh one.
            postRegistration(uuid, user, token) { address, _ ->
                if (address != null) saveRegistration(uuid, address, user)
            }
        }
    }

    // ── tap routing (PushPlugin → host activity) ─────────────────────────────

    /** Cold start: park the payload for getLaunch() BEFORE the engine boots. The intent's
     *  le.codes/qr data URI rides the normal launchUrl path unchanged. The extra is consumed so
     *  an Activity recreation doesn't re-park it (the iOS coldStartHandledId analog). */
    fun parkLaunchPayload(intent: Intent) {
        val raw = intent.getStringExtra(EXTRA_PAYLOAD) ?: return
        intent.removeExtra(EXTRA_PAYLOAD)
        launchPayload = runCatching { JSONObject(raw) }.getOrNull()
    }

    /** Warm tap (onNewIntent). @return true when consumed — the caller must then SKIP the
     *  generic deep-link path (a same-project tap must not reload the running app). */
    fun handleTapIntent(intent: Intent): Boolean {
        val raw = intent.getStringExtra(EXTRA_PAYLOAD) ?: return false
        intent.removeExtra(EXTRA_PAYLOAD)
        val payload = runCatching { JSONObject(raw) }.getOrNull() ?: return true
        val e = engine ?: return true
        val projectUuid = payload.optString("projectUuid")
        if (projectUuid == e.currentProjectUuid) {
            emitToSessions("tap", toJsPayload(payload))
            val url = payload.optString("url")
            if (url.isNotEmpty()) e.emitUrl(url)
        } else {
            launchPayload = payload   // the new world reads it via getLaunch()
            e.openLauncher("https://le.codes/qr/$projectUuid")
        }
        return true
    }

    // ── payload shapes ───────────────────────────────────────────────────────

    /** The FCM data map (all strings, buildFcmBody's shape) → internal payload. null = not ours. */
    fun payloadFromData(data: Map<String, String>): JSONObject? {
        val uuid = data["projectUuid"] ?: return null
        val payload = JSONObject()
            .put("projectUuid", uuid)
            .put("title", data["title"] ?: "")
        data["projectName"]?.let { payload.put("projectName", it) }
        data["body"]?.let { payload.put("body", it) }
        data["url"]?.let { payload.put("url", it) }
        data["badge"]?.toIntOrNull()?.let { payload.put("badge", it) }
        data["data"]?.let { raw -> runCatching { payload.put("data", JSONObject(raw)) } }
        return payload
    }

    /** Strip the routing fields before anything reaches JS (the host-side contract). */
    private fun toJsPayload(payload: JSONObject): JSONObject {
        val js = JSONObject()
        js.put("title", payload.optString("title"))
        if (payload.has("body")) js.put("body", payload.optString("body"))
        if (payload.has("url")) js.put("url", payload.optString("url"))
        if (payload.has("badge")) js.put("badge", payload.optInt("badge"))
        payload.optJSONObject("data")?.let { js.put("data", it) }
        return js
    }

    // ── permission (house rule: prompt on first call, never in factory) ──────

    private fun notificationsEnabled() = NotificationManagerCompat.from(appContext).areNotificationsEnabled()

    private fun withPermission(call: Services.ServiceCall, body: () -> Unit) {
        if (Build.VERSION.SDK_INT < 33) {
            if (notificationsEnabled()) body() else call.reject("denied")
            return
        }
        if (ContextCompat.checkSelfPermission(appContext, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED) return body()
        val e = engine ?: return call.reject("denied")
        if (e.getActivity() == null) return call.reject("denied")
        prefs.edit().putBoolean("permissionRequested", true).apply()
        PermissionRequester.request(e, arrayOf(Manifest.permission.POST_NOTIFICATIONS)) { granted ->
            if (granted) body() else call.reject("denied")
        }
    }

    // ── persistence (the iOS UserDefaults shape: projectUuid → { address, user }) ────────────

    private fun loadRegistrations(): JSONObject =
        runCatching { JSONObject(prefs.getString("registrations", null) ?: "{}") }.getOrDefault(JSONObject())

    private fun loadRegistration(projectUuid: String): JSONObject? =
        loadRegistrations().optJSONObject(projectUuid)

    private fun saveRegistration(projectUuid: String, address: String, user: String?) {
        val regs = loadRegistrations()
        val entry = JSONObject().put("address", address)
        if (user != null) entry.put("user", user)
        regs.put(projectUuid, entry)
        prefs.edit().putString("registrations", regs.toString()).apply()
    }

    private fun removeRegistration(projectUuid: String) {
        val regs = loadRegistrations()
        regs.remove(projectUuid)
        prefs.edit().putString("registrations", regs.toString()).apply()
    }

    // ── backend ──────────────────────────────────────────────────────────────

    private fun postRegistration(
        projectUuid: String, user: String?, token: String,
        onResult: (address: String?, error: String?) -> Unit,
    ) {
        val body = JSONObject()
            .put("projectUuid", projectUuid)
            .put("platform", "fcm")
            .put("token", token)
            .put("hostApp", appContext.packageName)
        if (user != null) body.put("user", user)

        httpExecutor.execute {
            val response = runCatching { httpJson("POST", "$API_BASE/api/push/registrations", body) }.getOrNull()
            when {
                response == null -> onResult(null, "unavailable")
                response.first in 200..299 -> {
                    val address = runCatching { JSONObject(response.second).optString("address") }
                        .getOrNull()?.takeIf { it.isNotEmpty() }
                    onResult(address, if (address == null) "registration failed" else null)
                }
                else -> onResult(null, runCatching { JSONObject(response.second).optString("error") }
                    .getOrNull()?.takeIf { it.isNotEmpty() } ?: "registration failed (${response.first})")
            }
        }
    }

    private fun httpJson(method: String, url: String, body: JSONObject): Pair<Int, String> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = connection.responseCode
            val text = (if (code in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            return code to text
        } finally {
            connection.disconnect()
        }
    }
}
