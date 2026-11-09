//
//  LeCodesMapPlugin.kt — lecodes-plugins/map
//
//  The plugin's two surfaces over maplibre-native (Maven `org.maplibre.gl:android-sdk-opengl`), one
//  map class under both (MapController.kt) — the Kotlin twin of MapPlugin.swift:
//   - the VIEW "map" (MapViewInstance): the fullscreen map the app pushes or opens; its params are
//     read once, at creation, and its view is the map view itself;
//   - the HOST NODE "map" (MapNodeInstance): the map as a box of a screen's layout, laid out and
//     painted by the core's holder (UINodeHost); its props are LIVE.
//  WHEN and WITH WHAT to show either is app (TS) code. The channels are the contract's
//  (../contract.d.ts): MapViewPlugin.gen.kt is generated from it (one file for both surfaces).
//
//  The node's rules (MapPlugin.swift's):
//   - Its props arrive one by one (the holder hands each write over, `kind` first), so the map is
//     made at the END of the node's first commit (a main-looper turn after its first prop), from every
//     prop that commit wrote — the style chosen at construction, loaded once (MapController). The
//     instance's view is a plain FrameLayout that takes the map view in then.
//   - Later commits are applied the same way, once per commit: a style write reloads the style once
//     (and only when it differs from the one shown — `ready` fires again then), the camera props
//     written (`center` / `zoom` / `bearing` / `pitch`) are ONE jump to what was written with the
//     rest of the camera kept, the zoom range and the gestures are set.
//   - A call flushes what is pending first: it sees every prop written before it.
//   - `destroy` (the node released) tears the map down; a flush after it does nothing.
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
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
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
        UIMapNodeGlue.register(engine) { events -> MapNodeInstance(appContext, events) }
    }
}

// ---- the View ---------------------------------------------------------------------------------

/** The view "map": a MapController made from the View's params, its map view the View's. */
internal class MapViewInstance(context: Context, params: MapParams, events: MapViewEvents) : MapViewPlugin {
    private val map = MapController(context, params, events.sink(), MapCodes(MapViewCode.NOT_READY, MapViewCode.NO_POINTS))

    override val view: View get() = map.mapView

    override fun destroy() = map.destroy()

    override fun ensureLayer(source: String, kind: MapLayerKind, options: MapLayerOptions?, reply: Reply<Unit, MapViewCode>) =
        map.ensureLayer(source, kind, options, reply)
    override fun removeLayer(source: String, reply: Reply<Unit, MapViewCode>) = map.removeLayer(source, reply)
    override fun setData(source: String, geojson: Any, reply: Reply<Unit, MapViewCode>) = map.setData(source, geojson, reply)
    override fun flyTo(center: Pair<Double, Double>, options: MapCameraMove?, reply: Reply<Unit, MapViewCode>) = map.flyTo(center, options, reply)
    override fun jumpTo(center: Pair<Double, Double>, options: MapCameraMove?, reply: Reply<Unit, MapViewCode>) = map.jumpTo(center, options, reply)
    override fun fitPoints(points: List<Pair<Double, Double>>, options: MapFitOptions?, reply: Reply<Unit, MapViewCode>) =
        map.fitPoints(points, options, reply)
    override fun setPadding(padding: MapPadding, reply: Reply<Unit, MapViewCode>) = map.setPadding(padding, reply)
    override fun getCamera(reply: Reply<MapCamera, MapViewCode>) = map.getCamera(reply)
    override fun setUserLocation(lngLat: Pair<Double, Double>?, options: MapUserLocationOptions?, reply: Reply<Unit, MapViewCode>) =
        map.setUserLocation(lngLat, options, reply)
}

// ---- the host node ----------------------------------------------------------------------------

/** The host node "map": a box of the layout holding a MapController (the header's rules). */
internal class MapNodeInstance(private val context: Context, private val events: UIMapNodeEvents) : UIMapNodeInstance {
    private enum class Prop { STYLE, CENTER, ZOOM, BEARING, PITCH, ZOOM_RANGE, GESTURES }

    private val box = FrameLayout(context)
    override val view: View get() = box
    /** Every prop as written last, in the View's params' fields (the prop `styleUrl` is `style`):
     *  what the map is made from. */
    private var props = MapParams()
    private val dirty = mutableSetOf<Prop>()
    private var flushQueued = false
    private var map: MapController<UIMapNodeCode>? = null
    /** The style the map shows: a write of the same one reloads nothing. */
    private var shownStyle: Pair<String?, String?> = Pair(null, null)
    private var destroyed = false

    override fun setStyleUrl(value: String?) { props = props.copy(style = value); mark(Prop.STYLE) }
    override fun setStyleJson(value: String?) { props = props.copy(styleJson = value); mark(Prop.STYLE) }
    override fun setCenter(value: Pair<Double, Double>?) { props = props.copy(center = value); mark(Prop.CENTER) }
    override fun setZoom(value: Double?) { props = props.copy(zoom = value); mark(Prop.ZOOM) }
    override fun setMinZoom(value: Double?) { props = props.copy(minZoom = value); mark(Prop.ZOOM_RANGE) }
    override fun setMaxZoom(value: Double?) { props = props.copy(maxZoom = value); mark(Prop.ZOOM_RANGE) }
    override fun setBearing(value: Double?) { props = props.copy(bearing = value); mark(Prop.BEARING) }
    override fun setPitch(value: Double?) { props = props.copy(pitch = value); mark(Prop.PITCH) }
    override fun setRotate(value: Boolean?) { props = props.copy(rotate = value); mark(Prop.GESTURES) }
    override fun setTilt(value: Boolean?) { props = props.copy(tilt = value); mark(Prop.GESTURES) }

    override fun destroy() {
        destroyed = true
        map?.destroy()
        map = null
    }

    /** A prop changed: applied with the rest of its commit, a main-looper turn later. */
    private fun mark(prop: Prop) {
        dirty.add(prop)
        if (flushQueued) return
        flushQueued = true
        main.post { flush() }
    }

    /** Apply what was written since the last flush — the first one makes the map from every prop.
     *  The map; null once destroyed. */
    private fun flush(): MapController<UIMapNodeCode>? {
        flushQueued = false
        if (destroyed) return null
        val changed = dirty.toSet()
        dirty.clear()
        val m = map ?: return MapController(context, props, events.sink(), CODES).also { made ->
            shownStyle = Pair(props.style, props.styleJson)
            box.addView(made.mapView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            map = made
        }
        if (Prop.STYLE in changed && shownStyle != Pair(props.style, props.styleJson)) {
            shownStyle = Pair(props.style, props.styleJson)
            m.setStyle(props.style, props.styleJson)
        }
        if (changed.any { it == Prop.CENTER || it == Prop.ZOOM || it == Prop.BEARING || it == Prop.PITCH }) {
            m.jump(
                center = if (Prop.CENTER in changed) props.center else null,
                zoom = if (Prop.ZOOM in changed) props.zoom else null,
                bearing = if (Prop.BEARING in changed) props.bearing else null,
                pitch = if (Prop.PITCH in changed) props.pitch else null,
            )
        }
        if (Prop.ZOOM_RANGE in changed) m.setZoomRange(props.minZoom, props.maxZoom)
        if (Prop.GESTURES in changed) m.setGestures(props.rotate, props.tilt)
        return m
    }

    // The calls see every prop written before them.

    override fun ensureLayer(source: String, kind: MapLayerKind, options: MapLayerOptions?, reply: Reply<Unit, UIMapNodeCode>) {
        val m = flush() ?: return reply.reject(UIMapNodeCode.NOT_READY)
        m.ensureLayer(source, kind, options, reply)
    }
    override fun removeLayer(source: String, reply: Reply<Unit, UIMapNodeCode>) {
        val m = flush() ?: return reply.resolve()
        m.removeLayer(source, reply)
    }
    override fun setData(source: String, geojson: Any, reply: Reply<Unit, UIMapNodeCode>) {
        val m = flush() ?: return reply.reject(UIMapNodeCode.NOT_READY)
        m.setData(source, geojson, reply)
    }
    override fun flyTo(center: Pair<Double, Double>, options: MapCameraMove?, reply: Reply<Unit, UIMapNodeCode>) {
        val m = flush() ?: return reply.reject(UIMapNodeCode.NOT_READY)
        m.flyTo(center, options, reply)
    }
    override fun jumpTo(center: Pair<Double, Double>, options: MapCameraMove?, reply: Reply<Unit, UIMapNodeCode>) {
        val m = flush() ?: return reply.reject(UIMapNodeCode.NOT_READY)
        m.jumpTo(center, options, reply)
    }
    override fun fitPoints(points: List<Pair<Double, Double>>, options: MapFitOptions?, reply: Reply<Unit, UIMapNodeCode>) {
        val m = flush() ?: return reply.reject(UIMapNodeCode.NOT_READY)
        m.fitPoints(points, options, reply)
    }
    override fun setPadding(padding: MapPadding, reply: Reply<Unit, UIMapNodeCode>) {
        val m = flush() ?: return reply.reject(UIMapNodeCode.NOT_READY)
        m.setPadding(padding, reply)
    }
    override fun getCamera(reply: Reply<MapCamera, UIMapNodeCode>) {
        val m = flush() ?: return reply.reject(UIMapNodeCode.NOT_READY)
        m.getCamera(reply)
    }
    override fun setUserLocation(lngLat: Pair<Double, Double>?, options: MapUserLocationOptions?, reply: Reply<Unit, UIMapNodeCode>) {
        val m = flush() ?: return reply.reject(UIMapNodeCode.NOT_READY)
        m.setUserLocation(lngLat, options, reply)
    }

    private companion object {
        val CODES = MapCodes(UIMapNodeCode.NOT_READY, UIMapNodeCode.NO_POINTS)
        val main by lazy { Handler(Looper.getMainLooper()) }
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
