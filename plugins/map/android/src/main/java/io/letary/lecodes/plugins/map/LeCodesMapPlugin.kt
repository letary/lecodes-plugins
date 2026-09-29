//
//  LeCodesMapPlugin.kt — lecodes-plugins/map
//
//  The "map" registerView plugin over maplibre-native (Maven `org.maplibre.gl:android-sdk-opengl`).
//  WHEN and WITH WHAT to show it is app (TS) code. The channel is the contract's (../contract.d.ts):
//  MapView.gen.kt is generated from it, MapViewInstance implements its MapViewPlugin.
//
//  Deliberately NOT here: MapLibre's LocationComponent (the puck is our own GeoJSON layer fed by
//  the app), attribution/logo/compass chrome, and any permission prompt — an app with `map` but
//  without `geolocation` has no location story.
//

package io.letary.lecodes.plugins.map

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import io.letary.lecodes.LecodesEngine
import org.maplibre.android.MapLibre
import org.maplibre.android.maps.MapView

object LeCodesMapPlugin {

    const val PLUGIN_ID = "map"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        // Must precede the first MapView (asset/file-source init, one per process — idempotent).
        MapLibre.getInstance(appContext)
        MapLifecycle.install(appContext)
        MapViewChannel.register(engine) { params, events -> MapViewInstance(appContext, params, events) }
    }
}

/**
 * MapLibre's MapView must be told the activity lifecycle (onStart/onResume/onPause/onStop/
 * onDestroy) or it renders nothing / leaks its GL thread. The host exposes no lifecycle hooks
 * to plugins, so the plugin listens to the Application's ActivityLifecycleCallbacks itself —
 * every live map view follows the foreground activity. One activity is the LeCodes host model
 * (singleTask); a second activity in front of it (a permission dialog is not one) would pause
 * the maps, which is the right thing anyway.
 *
 * A view created while the activity is already resumed (the normal case: the map opens from a
 * tap) is started + resumed immediately; the state flags start as "foreground" so a plugin
 * registered before the first callback still gets a rendering map.
 */
internal object MapLifecycle : Application.ActivityLifecycleCallbacks {

    private class Tracked(val view: MapView) { var started = false; var resumed = false }

    private val maps = mutableListOf<Tracked>()
    private var installed = false
    private var started = true
    private var resumed = true

    fun install(context: Context) {
        if (installed) return
        val app = context.applicationContext as? Application ?: return
        app.registerActivityLifecycleCallbacks(this)
        installed = true
    }

    fun track(view: MapView) {
        val t = Tracked(view)
        maps.add(t)
        view.onCreate(null)
        if (started) start(t)
        if (resumed) resume(t)
    }

    fun untrack(view: MapView) {
        val t = maps.firstOrNull { it.view === view } ?: return
        maps.remove(t)
        pause(t)
        stop(t)
        view.onDestroy()
    }

    private fun start(t: Tracked) { if (!t.started) { t.started = true; t.view.onStart() } }
    private fun resume(t: Tracked) { if (t.started && !t.resumed) { t.resumed = true; t.view.onResume() } }
    private fun pause(t: Tracked) { if (t.resumed) { t.resumed = false; t.view.onPause() } }
    private fun stop(t: Tracked) { if (t.started) { t.started = false; t.view.onStop() } }

    override fun onActivityStarted(activity: Activity) { started = true; maps.toList().forEach { start(it) } }
    override fun onActivityResumed(activity: Activity) { resumed = true; maps.toList().forEach { resume(it) } }
    override fun onActivityPaused(activity: Activity) { resumed = false; maps.toList().forEach { pause(it) } }
    override fun onActivityStopped(activity: Activity) { started = false; maps.toList().forEach { stop(it) } }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
}
