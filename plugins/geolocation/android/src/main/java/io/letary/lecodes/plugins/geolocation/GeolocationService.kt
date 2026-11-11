//
//  GeolocationService.kt — lecodes-plugins/geolocation
//
//  One session of the "geolocation" service: the contract's GeolocationPlugin (Geolocation.gen.kt
//  reads the calls off the wire). The OS permission is the contract's (`@permission location`): the
//  generated glue asks the host before a call reaches here, so a call arrives permitted.
//

package io.letary.lecodes.plugins.geolocation

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
import android.os.SystemClock
import androidx.core.content.ContextCompat
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve

class GeolocationService(
    context: Context,
    private val events: GeolocationEvents,
) : GeolocationPlugin {
    private val appContext = context.applicationContext
    private val manager = appContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val mainHandler = Handler(Looper.getMainLooper())

    /** The watch's listeners, one per provider it follows. */
    private var watchListeners: List<LocationListener> = emptyList()
    /** The fix the watch sent last, and whether the satellites gave it. */
    private var sent: Location? = null
    private var sentByGps = false

    override fun close() = stopWatch()

    // ── calls ────────────────────────────────────────────────────────────────

    override fun getCurrent(options: GeoOptions?, reply: Reply<GeoPosition, GeolocationCode>) {
        run {
            val provider = pickProvider(options?.highAccuracy ?: false)
                ?: return reply.reject(GeolocationCode.UNAVAILABLE)
            val timeout = options?.timeout?.toLong() ?: 0L

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val cancel = CancellationSignal()
                if (timeout > 0) mainHandler.postDelayed({
                    if (!cancel.isCanceled) { cancel.cancel(); reply.reject(GeolocationCode.TIMEOUT) }
                }, timeout)
                requestCurrentLocation(provider, cancel) { location ->
                    if (location != null) reply.resolve(position(location)) else reply.reject(GeolocationCode.UNAVAILABLE)
                }
            } else {
                var timedOut = false
                val listener = object : LocationListener {
                    override fun onLocationChanged(location: Location) {
                        if (!timedOut) reply.resolve(position(location))
                    }
                    @Deprecated("Deprecated in Java")
                    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                }
                if (timeout > 0) mainHandler.postDelayed({
                    timedOut = true
                    manager.removeUpdates(listener)
                    reply.reject(GeolocationCode.TIMEOUT)
                }, timeout)
                requestSingleUpdate(provider, listener) { reply.reject(GeolocationCode.UNAVAILABLE) }
            }
        }
    }

    override fun startWatch(options: GeoOptions?, reply: Reply<Unit, GeolocationCode>) {
        run {
            if (watchListeners.isNotEmpty()) return reply.resolve()   // already watching
            val providers = watchProviders(options?.highAccuracy ?: false)
            sent = null
            sentByGps = false
            val started = providers.mapNotNull { provider ->
                val listener = LocationListener { location -> watched(location) }
                try {
                    @SuppressLint("MissingPermission")
                    manager.requestLocationUpdates(provider, WATCH_INTERVAL_MS, 0f, listener, Looper.getMainLooper())
                    listener
                } catch (e: Exception) {
                    null
                }
            }
            if (started.isEmpty()) return reply.reject(GeolocationCode.UNAVAILABLE)
            watchListeners = started
            reply.resolve()
        }
    }

    override fun stopWatch(reply: Reply<Unit, GeolocationCode>) {
        stopWatch()
        reply.resolve()
    }

    private fun stopWatch() {
        for (listener in watchListeners) manager.removeUpdates(listener)
        watchListeners = emptyList()
    }

    /**
     * A fix of the watch. A precise watch follows the satellites AND the network: the network
     * answers in a second or two, also indoors, the satellites take their time and then are the
     * better ones. So a satellite fix always goes to the app, a network fix only while no fresh
     * satellite fix stands — before the first one, and once they stop coming.
     */
    private fun watched(location: Location) {
        val byGps = location.provider == LocationManager.GPS_PROVIDER
        val last = sent
        if (!byGps && sentByGps && last != null) {
            val ageMs = (SystemClock.elapsedRealtimeNanos() - last.elapsedRealtimeNanos) / 1_000_000
            if (ageMs < GPS_FRESH_MS) return
        }
        sent = location
        sentByGps = byGps
        events.position(position(location))
    }

    // ── plumbing ─────────────────────────────────────────────────────────────

    private fun enabled(provider: String) = runCatching { manager.isProviderEnabled(provider) }.getOrDefault(false)

    /** What a watch follows: one provider, or for a precise watch the satellites beside the network (`watched`). */
    private fun watchProviders(highAccuracy: Boolean): List<String> {
        if (highAccuracy) {
            val coarse = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) LocationManager.FUSED_PROVIDER else LocationManager.NETWORK_PROVIDER
            val both = listOf(LocationManager.GPS_PROVIDER, coarse).filter { enabled(it) }
            if (both.isNotEmpty()) return both
        }
        return listOfNotNull(pickProvider(highAccuracy))
    }

    private fun pickProvider(highAccuracy: Boolean): String? {
        val preferred =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !highAccuracy) LocationManager.FUSED_PROVIDER
            else if (highAccuracy) LocationManager.GPS_PROVIDER
            else LocationManager.NETWORK_PROVIDER
        val fallbacks = listOf(preferred, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
        return fallbacks.firstOrNull { enabled(it) }
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

    private fun position(location: Location) = GeoPosition(
        latitude = location.latitude,
        longitude = location.longitude,
        accuracy = if (location.hasAccuracy()) location.accuracy.toDouble() else 0.0,
        altitude = if (location.hasAltitude()) location.altitude else null,
        heading = if (location.hasBearing()) location.bearing.toDouble() else null,
        speed = if (location.hasSpeed()) location.speed.toDouble() else null,
        timestamp = location.time.toDouble(),
    )

    companion object {
        private const val WATCH_INTERVAL_MS = 1000L
        /** How long a satellite fix stands before a network fix may replace it. */
        private const val GPS_FRESH_MS = 10_000L
    }
}
