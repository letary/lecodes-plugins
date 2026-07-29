//
//  GeolocationService.kt — lecodes-plugins/geolocation
//
//  Contract (docs/service-channel-plan.md): calls `getCurrent(options)` / `startWatch(options)` /
//  `stopWatch()`, event `position`; errors are "denied" / "unavailable" / "timeout".
//  The OS permission prompt happens on the first call that needs it (never in the factory),
//  via the SDK's PermissionRequester.
//

package io.letary.lecodes.plugins.geolocation

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.utils.PermissionRequester
import io.letary.lecodes.utils.Services
import org.json.JSONObject

class GeolocationService(
    private val engine: LecodesEngine,
    context: Context,
    private val channel: Services.Channel,
) {
    private val appContext = context.applicationContext
    private val manager = appContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private var watchListener: LocationListener? = null

    fun instance() = Services.Instance(
        onCall = { call ->
            when (call.method) {
                "getCurrent" -> getCurrent(call, call.args.optJSONObject(0) ?: JSONObject())
                "startWatch" -> startWatch(call, call.args.optJSONObject(0) ?: JSONObject())
                "stopWatch" -> { stopWatch(); call.resolve() }
                else -> call.reject("geolocation: unknown method \"${call.method}\"")
            }
        },
        onClose = { stopWatch() },
    )

    // ── calls ────────────────────────────────────────────────────────────────

    private fun getCurrent(call: Services.ServiceCall, options: JSONObject) {
        withPermission(call) {
            val provider = pickProvider(options.optBoolean("highAccuracy", false))
                ?: return@withPermission call.reject("unavailable")
            val timeout = options.optLong("timeout", 0L)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val cancel = CancellationSignal()
                if (timeout > 0) mainHandler.postDelayed({
                    if (!cancel.isCanceled) { cancel.cancel(); call.reject("timeout") }
                }, timeout)
                requestCurrentLocation(provider, cancel) { location ->
                    if (location != null) call.resolve(toJson(location)) else call.reject("unavailable")
                }
            } else {
                var timedOut = false
                val listener = object : LocationListener {
                    override fun onLocationChanged(location: Location) {
                        if (!timedOut) call.resolve(toJson(location))
                    }
                    @Deprecated("Deprecated in Java")
                    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                }
                if (timeout > 0) mainHandler.postDelayed({
                    timedOut = true
                    manager.removeUpdates(listener)
                    call.reject("timeout")
                }, timeout)
                requestSingleUpdate(provider, listener) { call.reject("unavailable") }
            }
        }
    }

    private fun startWatch(call: Services.ServiceCall, options: JSONObject) {
        withPermission(call) {
            if (watchListener != null) return@withPermission call.resolve()   // already watching
            val provider = pickProvider(options.optBoolean("highAccuracy", false))
                ?: return@withPermission call.reject("unavailable")
            val listener = LocationListener { location -> channel.emit("position", toJson(location).toString()) }
            try {
                @SuppressLint("MissingPermission")
                manager.requestLocationUpdates(provider, WATCH_INTERVAL_MS, 0f, listener, Looper.getMainLooper())
                watchListener = listener
                call.resolve()
            } catch (e: Exception) {
                call.reject("unavailable")
            }
        }
    }

    private fun stopWatch() {
        watchListener?.let { manager.removeUpdates(it) }
        watchListener = null
    }

    // ── plumbing ─────────────────────────────────────────────────────────────

    /** Run [body] once location permission is granted; reject "denied" otherwise.
     *  FINE + COARSE together: the system dialog lets the user pick "approximate", which
     *  grants COARSE only — still a grant for our purposes (PermissionRequester's ANY rule). */
    private fun withPermission(call: Services.ServiceCall, body: () -> Unit) {
        if (hasPermission()) return body()
        PermissionRequester.request(
            engine,
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
        ) { granted ->
            if (granted) body() else call.reject("denied")
        }
    }

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED

    private fun pickProvider(highAccuracy: Boolean): String? {
        val preferred =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !highAccuracy) LocationManager.FUSED_PROVIDER
            else if (highAccuracy) LocationManager.GPS_PROVIDER
            else LocationManager.NETWORK_PROVIDER
        val fallbacks = listOf(preferred, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
        return fallbacks.firstOrNull { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
    }

    @SuppressLint("MissingPermission")
    private fun requestCurrentLocation(provider: String, cancel: CancellationSignal, onResult: (Location?) -> Unit) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                manager.getCurrentLocation(provider, cancel, ContextCompat.getMainExecutor(appContext)) { onResult(it) }
            }
        } catch (e: Exception) {
            onResult(null)
        }
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    private fun requestSingleUpdate(provider: String, listener: LocationListener, onError: () -> Unit) {
        try {
            manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
        } catch (e: Exception) {
            onError()
        }
    }

    private fun toJson(location: Location): JSONObject = JSONObject().apply {
        put("latitude", location.latitude)
        put("longitude", location.longitude)
        put("accuracy", if (location.hasAccuracy()) location.accuracy.toDouble() else 0.0)
        put("altitude", if (location.hasAltitude()) location.altitude else JSONObject.NULL)
        put("heading", if (location.hasBearing()) location.bearing.toDouble() else JSONObject.NULL)
        put("speed", if (location.hasSpeed()) location.speed.toDouble() else JSONObject.NULL)
        put("timestamp", location.time)
    }

    companion object { private const val WATCH_INTERVAL_MS = 1000L }
}
