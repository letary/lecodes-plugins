//
//  MapViewInstance.kt — lecodes-plugins/map
//
//  One live "map" view: a MapLibre MapView behind the contract's MapViewPlugin (MapView.gen.kt
//  reads the calls off the wire). Everything here runs on the main thread (the JS thread on
//  Android — the host dispatches a call there and MapLibre is main-thread-only), so there is no
//  hopping and no locking.
//
//  Units: the SDK speaks LOGICAL px (dp) — padding, tap points; MapLibre's camera/padding APIs
//  take DEVICE px and its style properties (circle radius, offsets) take style px = dp. The
//  `density` factor converts at the edges.
//

package io.letary.lecodes.plugins.map

import android.content.Context
import android.graphics.PointF
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapLibreMapOptions
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.sources.GeoJsonSource
import kotlin.math.min

internal class MapViewInstance(
    private val context: Context,
    params: MapParams,
    private val events: MapViewEvents,
) : MapViewPlugin {
    private val density = context.resources.displayMetrics.density
    private val mapView: MapView
    private var map: MapLibreMap? = null
    private var style: Style? = null
    private var ready = false

    /** Sources the app manages through the layer API (name → how it was created). */
    private val managed = mutableMapOf<String, MapLayers.Managed>()
    /** The last `setPadding` spec (dp numbers or "NN%" strings), re-resolved on layout. */
    private var paddingSpec: MapPadding? = null
    private var user = MapLayers.UserPuck(density)

    /** What the map shows when the app gave no usable style (an `error` event follows). */
    private val blankStyle = """{"version":8,"sources":{},"layers":[]}"""

    init {
        // Same rule as iOS: the style is chosen at CONSTRUCTION and loaded exactly once. `styleJson`
        // (a bundled asset(), a read file, an inline object — resolved to text by the SDK wrapper)
        // wins over `style`, a URL the map fetches itself. A JSON style has no base URL, so every
        // url inside it must be absolute (maplibre-native resolves no relative ones either way).
        var styleError: String? = null
        val styleBuilder = Style.Builder()
        val styleJson = params.styleJson ?: ""
        val styleUrl = params.style ?: ""
        when {
            styleJson.isNotEmpty() -> {
                if (MapLayers.isValidJson(styleJson)) styleBuilder.fromJson(styleJson)
                else { styleError = "MapView: the style is not valid JSON"; styleBuilder.fromJson(blankStyle) }
            }
            styleUrl.isNotEmpty() -> styleBuilder.fromUri(styleUrl)
            else -> { styleError = "MapView: `style` must be a URL or a style JSON"; styleBuilder.fromJson(blankStyle) }
        }

        val camera = CameraPosition.Builder()
        MapLayers.coordinate(params.center)?.let { camera.target(it) }
        camera.zoom(params.zoom ?: 12.0)
        camera.bearing(params.bearing ?: 0.0)
        camera.tilt(params.pitch ?: 0.0)

        // TextureView rendering: the view reparents on promotion (embedded node ↔ fullscreen
        // destination) and rides the host's screen transitions — a SurfaceView would punch a hole
        // through them. Chrome off: the app draws its own attribution/controls as widgets.
        val options = MapLibreMapOptions.createFromAttributes(context)
            .textureMode(true)
            .attributionEnabled(false)
            .logoEnabled(false)
            .compassEnabled(false)
            .rotateGesturesEnabled(params.rotate ?: true)
            .tiltGesturesEnabled(params.tilt ?: false)
            .camera(camera.build())
        params.minZoom?.let { options.minZoomPreference(it) }
        params.maxZoom?.let { options.maxZoomPreference(it) }

        mapView = LeCodesMapView(context, options)
        MapLifecycle.track(mapView)
        if (styleError != null) events.error(styleError)

        mapView.addOnDidFailLoadingMapListener { message ->
            events.error(message ?: "map failed to load")
        }
        mapView.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or_, ob ->
            if (r - l != or_ - ol || b - t != ob - ot) applyPadding()
        }

        mapView.getMapAsync { m ->
            map = m
            m.uiSettings.isAttributionEnabled = false
            m.uiSettings.isLogoEnabled = false
            m.uiSettings.isCompassEnabled = false
            m.addOnMapClickListener { latLng -> handleTap(latLng); true }
            m.addOnCameraMoveListener { user.rescale(m) }
            m.addOnCameraIdleListener {
                user.rescale(m)
                if (ready) events.moveEnd(cameraPayload(m))
            }
            m.setStyle(styleBuilder) { s -> styleLoaded(s) }
        }
    }

    override val view: android.view.View get() = mapView

    override fun destroy() {
        style = null
        map = null
        (mapView.parent as? android.view.ViewGroup)?.removeView(mapView)
        MapLifecycle.untrack(mapView)
    }

    // ---- the contract's calls ---------------------------------------------------------------

    override fun ensureLayer(source: String, kind: MapLayerKind, options: MapLayerOptions?, reply: Reply<Unit, MapViewCode>) =
        settle(reply) { ensureLayer(source, kind, options ?: MapLayerOptions()) }

    override fun removeLayer(source: String, reply: Reply<Unit, MapViewCode>) {
        removeLayer(source)
        reply.resolve()
    }

    override fun setData(source: String, geojson: Any, reply: Reply<Unit, MapViewCode>) =
        settle(reply) { setData(source, geojson) }

    override fun flyTo(center: Pair<Double, Double>, options: MapCameraMove?, reply: Reply<Unit, MapViewCode>) =
        move(center, options, animated = true, reply)

    override fun jumpTo(center: Pair<Double, Double>, options: MapCameraMove?, reply: Reply<Unit, MapViewCode>) =
        move(center, options, animated = false, reply)

    override fun fitPoints(points: List<Pair<Double, Double>>, options: MapFitOptions?, reply: Reply<Unit, MapViewCode>) {
        val coordinates = points.mapNotNull { MapLayers.coordinate(it) }
        if (coordinates.isEmpty()) return reply.reject(MapViewCode.NO_POINTS)
        settle(reply) { fitPoints(coordinates, options ?: MapFitOptions()) }
    }

    override fun setPadding(padding: MapPadding, reply: Reply<Unit, MapViewCode>) {
        paddingSpec = padding
        applyPadding()
        reply.resolve()
    }

    override fun getCamera(reply: Reply<MapCamera, MapViewCode>) {
        val m = map ?: return reply.reject(MapViewCode.NOT_READY)
        reply.resolve(cameraPayload(m))
    }

    override fun setUserLocation(lngLat: Pair<Double, Double>?, options: MapUserLocationOptions?, reply: Reply<Unit, MapViewCode>) {
        setUserLocation(MapLayers.coordinate(lngLat), options?.accuracy, options?.heading)
        reply.resolve()
    }

    private fun move(center: Pair<Double, Double>, options: MapCameraMove?, animated: Boolean, reply: Reply<Unit, MapViewCode>) {
        val coordinate = MapLayers.coordinate(center) ?: return reply.fail("the latitude ${center.second} is off the globe")
        settle(reply) { moveCamera(coordinate, options ?: MapCameraMove(), animated) }
    }

    /** Run a call's work: "the style hasn't loaded" is the contract's code, anything else a message. */
    private fun settle(reply: Reply<Unit, MapViewCode>, body: () -> Unit) {
        try {
            body()
            reply.resolve()
        } catch (e: MapError) {
            if (e.notReady) reply.reject(MapViewCode.NOT_READY) else reply.fail(e.message ?: "map: failed")
        }
    }

    // ---- sources and layers -----------------------------------------------------------------

    private fun setData(name: String, geojson: Any) {
        val s = style ?: throw MapError.notReady()
        val source = s.getSourceAs<GeoJsonSource>(name)
            ?: throw MapError("unknown GeoJSON source \"$name\" — call ensureLayer / map.markers(name) first, or declare it in the style")
        var payload = geojson
        val entry = managed[name]
        if (entry is MapLayers.Managed.Defaults && entry.kind == MapLayerKind.MARKERS) payload = MapLayers.withMarkerDefaults(geojson)
        source.setGeoJson(payload.toString())
    }

    private fun ensureLayer(name: String, kind: MapLayerKind, options: MapLayerOptions) {
        val s = style ?: throw MapError.notReady()
        if (managed.containsKey(name)) return
        if (s.getSource(name) != null) {
            managed[name] = MapLayers.Managed.StyleOwned
            return
        }
        val created = MapLayers.addDefaultLayers(name, kind, options, s, below = user.bottomLayerId)
        managed[name] = MapLayers.Managed.Defaults(kind, created)
    }

    private fun removeLayer(name: String) {
        val s = style ?: return
        val entry = managed.remove(name) ?: return
        if (entry is MapLayers.Managed.Defaults) {
            for (id in entry.layerIds) s.removeLayer(id)
            s.removeSource(name)
        } else {
            s.getSourceAs<GeoJsonSource>(name)?.setGeoJson(MapLayers.EMPTY_COLLECTION)
        }
    }

    // ---- camera -----------------------------------------------------------------------------

    private fun moveCamera(center: LatLng, options: MapCameraMove, animated: Boolean) {
        val m = map ?: throw MapError.notReady()
        val current = m.cameraPosition
        val position = CameraPosition.Builder()
            .target(center)
            .zoom(options.zoom ?: current.zoom)
            .bearing(options.bearing ?: current.bearing)
            .tilt(options.pitch ?: current.tilt)
            .build()
        val update = CameraUpdateFactory.newCameraPosition(position)
        if (animated) m.animateCamera(update, (options.duration ?: 600.0).toInt().coerceAtLeast(1))
        else m.moveCamera(update)
    }

    private fun fitPoints(points: List<LatLng>, options: MapFitOptions) {
        val m = map ?: throw MapError.notReady()
        val animate = options.animate ?: true
        // A single point has no extent: fit would zoom to the maximum, so cap it.
        val maxZoom = options.maxZoom ?: if (points.size == 1) 16.0 else Double.POSITIVE_INFINITY

        val position: CameraPosition = if (points.size == 1) {
            CameraPosition.Builder().target(points[0]).zoom(min(maxZoom, 16.0)).build()
        } else {
            // The view padding (setPadding) is folded into the fit: MapLibre's bounds fit does
            // not read the camera padding by itself (the iOS contentInset does).
            val view = paddingPx()
            val edge = MapLayers.insetsPx(options.padding, mapView.width, mapView.height, density)
            val bounds = LatLngBounds.Builder().also { b -> points.forEach { b.include(it) } }.build()
            val fitted = m.getCameraForLatLngBounds(bounds, intArrayOf(
                view[0] + edge[0], view[1] + edge[1], view[2] + edge[2], view[3] + edge[3]))
                ?: return
            if (fitted.zoom > maxZoom) CameraPosition.Builder(fitted).zoom(maxZoom).build() else fitted
        }
        val update = CameraUpdateFactory.newCameraPosition(position)
        if (animate) m.animateCamera(update, 600) else m.moveCamera(update)
    }

    /** The current padding spec in device px: [left, top, right, bottom]. */
    private fun paddingPx(): IntArray = MapLayers.insetsPx(paddingSpec, mapView.width, mapView.height, density)

    private fun applyPadding() {
        val m = map ?: return
        val p = paddingPx()
        val current = m.cameraPosition.padding
        if (current != null && current.size == 4 &&
            current[0].toInt() == p[0] && current[1].toInt() == p[1] && current[2].toInt() == p[2] && current[3].toInt() == p[3]) return
        m.moveCamera(CameraUpdateFactory.paddingTo(p[0].toDouble(), p[1].toDouble(), p[2].toDouble(), p[3].toDouble()))
    }

    private fun cameraPayload(m: MapLibreMap): MapCamera {
        val c = m.cameraPosition
        val target = c.target ?: LatLng(0.0, 0.0)
        return MapCamera(center = Pair(target.longitude, target.latitude), zoom = c.zoom, bearing = c.bearing, pitch = c.tilt)
    }

    // ---- user puck --------------------------------------------------------------------------

    private fun setUserLocation(coordinate: LatLng?, accuracy: Double?, heading: Double?) {
        val s = style ?: return
        val m = map ?: return
        user.ensureLayers(s)
        user.update(coordinate, accuracy, heading, m)
    }

    // ---- style lifecycle --------------------------------------------------------------------

    private fun styleLoaded(s: Style) {
        style = s
        // A style (re)load drops every runtime source/layer — the wrapper re-applies them on `ready`.
        managed.clear()
        user = MapLayers.UserPuck(density)
        ready = true
        events.ready()
    }

    // ---- taps -------------------------------------------------------------------------------

    private fun handleTap(latLng: LatLng) {
        val m = map ?: return
        val s = style ?: return
        val point: PointF = m.projection.toScreenLocation(latLng)
        val tap = MapTap(
            lngLat = Pair(latLng.longitude, latLng.latitude),
            point = Pair((point.x / density).toDouble(), (point.y / density).toDouble()),
        )

        // Hit-test by SOURCE: every rendered layer drawing one of the app's sources counts,
        // whether the style declared it or the plugin built the defaults.
        for (name in managed.keys) {
            val layerIds = s.layers.filter { MapLayers.sourceIdOf(it) == name }.map { it.id }
            if (layerIds.isEmpty()) continue
            val features = m.queryRenderedFeatures(point, *layerIds.toTypedArray())
            val feature = features.firstOrNull() ?: continue

            // A cluster tap zooms to the level where it splits — no event.
            if (MapLayers.isCluster(feature)) {
                val source = s.getSourceAs<GeoJsonSource>(name)
                if (source != null) {
                    val zoom = source.getClusterExpansionZoom(feature)
                    val center = MapLayers.featureCoordinate(feature) ?: latLng
                    m.animateCamera(CameraUpdateFactory.newLatLngZoom(center, zoom.toDouble()), 400)
                    return
                }
            }

            events.tap(tap.copy(feature = MapFeature(source = name, id = MapLayers.featureId(feature), properties = MapLayers.featureProperties(feature))))
            return
        }
        events.tap(tap)
    }
}

/**
 * MapView whose children get measured even when the host lays it out WITHOUT a measure pass
 * (LeCodes hands a native destination its box through `layout()` alone; a FrameLayout then sizes
 * its children by their measured size — 0×0 for the TextureView, i.e. a map that never draws).
 */
internal class LeCodesMapView(context: Context, options: MapLibreMapOptions) : MapView(context, options) {
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        val w = right - left
        val h = bottom - top
        if (w > 0 && h > 0 && (measuredWidth != w || measuredHeight != h)) {
            measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
        }
        super.onLayout(changed, left, top, right, bottom)
    }
}

internal class MapError(message: String, val notReady: Boolean = false) : Exception(message) {
    companion object {
        fun notReady() = MapError("the style hasn't loaded yet", notReady = true)
    }
}
