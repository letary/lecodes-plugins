//
//  MapLayers.kt — lecodes-plugins/map
//
//  The style-side helpers behind MapViewInstance: default layers for app-created sources (a
//  colored dot + optional icon + optional label, clusters on request; a line), the user puck
//  (dot + accuracy halo + heading arrow — our own GeoJSON source, never MapLibre's
//  LocationComponent), and the contract's types <-> MapLibre conversions. The Kotlin twin of MapLayers.swift:
//  the same layer ids, the same colors, the same rules, so a style renders the same on both.
//
//  The LOOK of the defaults is deliberately plain: an app that wants designed markers declares
//  the source in its style JSON and the plugin only pushes data (`Managed.StyleOwned`).
//

package io.letary.lecodes.plugins.map

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.util.DisplayMetrics
import com.google.gson.JsonPrimitive
import org.json.JSONObject
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.Style
import org.maplibre.android.style.expressions.Expression
import org.maplibre.android.style.layers.CircleLayer
import org.maplibre.android.style.layers.FillExtrusionLayer
import org.maplibre.android.style.layers.FillLayer
import org.maplibre.android.style.layers.HeatmapLayer
import org.maplibre.android.style.layers.HillshadeLayer
import org.maplibre.android.style.layers.Layer
import org.maplibre.android.style.layers.LineLayer
import org.maplibre.android.style.layers.Property
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.layers.RasterLayer
import org.maplibre.android.style.layers.SymbolLayer
import org.maplibre.android.style.sources.GeoJsonOptions
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.Point
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

internal object MapLayers {

    sealed class Managed {
        /** The style declares the source; its layers are used untouched. */
        object StyleOwned : Managed()
        /** The plugin created the source and these layers. */
        class Defaults(val kind: MapLayerKind, val layerIds: List<String>) : Managed()
    }

    const val DEFAULT_MARKER_COLOR = "#DD4B40"
    const val EMPTY_COLLECTION = """{"type":"FeatureCollection","features":[]}"""

    // ---- the contract's types ↔ MapLibre -----------------------------------------------------

    /** `[lng, lat]` → LatLng; a latitude off the globe → null (LatLng would throw). */
    fun coordinate(value: Pair<Double, Double>?): LatLng? {
        val (lng, lat) = value ?: return null
        if (lng.isNaN() || lat.isNaN() || lat < -90 || lat > 90) return null
        return LatLng(lat, lng)
    }

    fun isValidJson(text: String): Boolean = try { JSONObject(text); true } catch (_: Exception) { false }

    /** A padding (`{ top, left, bottom, right }` of dp numbers / `"NN%"` strings) → device px
     *  `[left, top, right, bottom]` for a view of (widthPx, heightPx). */
    fun insetsPx(padding: MapPadding?, widthPx: Int, heightPx: Int, density: Float): IntArray {
        fun edge(inset: MapInset?, extent: Int): Int = when (inset) {
            null -> 0
            is MapInset.OfNumber -> (inset.value * density).roundToInt()
            is MapInset.OfString -> {
                val pct = if (inset.value.endsWith("%")) inset.value.dropLast(1).toDoubleOrNull() else null
                if (pct == null) 0 else (extent * pct / 100).roundToInt()
            }
        }
        return intArrayOf(edge(padding?.left, widthPx), edge(padding?.top, heightPx), edge(padding?.right, widthPx), edge(padding?.bottom, heightPx))
    }

    /** The padding of a fit: one number for every edge, or a padding. */
    fun insetsPx(padding: MapFitOptionsPadding?, widthPx: Int, heightPx: Int, density: Float): IntArray = when (padding) {
        null -> intArrayOf(0, 0, 0, 0)
        is MapFitOptionsPadding.OfNumber -> (padding.value * density).roundToInt().let { intArrayOf(it, it, it, it) }
        is MapFitOptionsPadding.OfMapPadding -> insetsPx(padding.value, widthPx, heightPx, density)
    }

    /** Plugin-built marker layers read `color` — fill the default where an item didn't say. */
    fun withMarkerDefaults(geojson: Any): Any {
        val collection = geojson as? JSONObject ?: return geojson
        val features = collection.optJSONArray("features") ?: return geojson
        for (i in 0 until features.length()) {
            val feature = features.optJSONObject(i) ?: continue
            val props = feature.optJSONObject("properties") ?: JSONObject().also { feature.put("properties", it) }
            if (!props.has("color") || props.isNull("color")) props.put("color", DEFAULT_MARKER_COLOR)
        }
        return collection
    }

    /** The `id` an item was given (its `properties.id`), else the feature's own; null when it has none. */
    fun featureId(feature: Feature): MapFeatureId? {
        val prop = feature.getProperty("id")
        if (prop is JsonPrimitive) {
            if (prop.isNumber) return MapFeatureId.OfNumber(prop.asDouble)
            if (prop.isString) return MapFeatureId.OfString(prop.asString)
        }
        return feature.id()?.let { MapFeatureId.OfString(it) }
    }

    fun featureProperties(feature: Feature): Map<String, Any> {
        val props = feature.properties() ?: return emptyMap()
        val json = try { JSONObject(props.toString()) } catch (_: Exception) { return emptyMap() }
        val out = LinkedHashMap<String, Any>()
        for (key in json.keys()) out[key] = json.opt(key) ?: JSONObject.NULL
        return out
    }

    fun featureCoordinate(feature: Feature): LatLng? {
        val point = feature.geometry() as? Point ?: return null
        return LatLng(point.latitude(), point.longitude())
    }

    fun isCluster(feature: Feature): Boolean =
        feature.hasProperty("point_count") || (feature.getProperty("cluster")?.let { it is JsonPrimitive && it.isBoolean && it.asBoolean } ?: false)

    /** The source a layer draws. MapLibre exposes it per subclass, not on Layer. */
    fun sourceIdOf(layer: Layer): String? = when (layer) {
        is CircleLayer -> layer.sourceId
        is SymbolLayer -> layer.sourceId
        is LineLayer -> layer.sourceId
        is FillLayer -> layer.sourceId
        is FillExtrusionLayer -> layer.sourceId
        is HeatmapLayer -> layer.sourceId
        is HillshadeLayer -> layer.sourceId
        is RasterLayer -> layer.sourceId
        else -> null
    }

    fun parseColor(hex: String?): Int? {
        if (hex == null) return null
        var s = hex.trim()
        if (s.startsWith("#")) s = s.substring(1)
        if (s.length != 6 && s.length != 8) return null
        val value = s.toLongOrNull(16) ?: return null
        return if (s.length == 8) {
            // #RRGGBBAA (CSS order) → ARGB
            val a = (value and 0xFF).toInt()
            Color.argb(a, ((value shr 24) and 0xFF).toInt(), ((value shr 16) and 0xFF).toInt(), ((value shr 8) and 0xFF).toInt())
        } else {
            Color.rgb(((value shr 16) and 0xFF).toInt(), ((value shr 8) and 0xFF).toInt(), (value and 0xFF).toInt())
        }
    }

    // ---- default layers ---------------------------------------------------------------------

    /** Create the source + layers for an app-managed name. Returns the layer ids (for removal). */
    fun addDefaultLayers(name: String, kind: MapLayerKind, options: MapLayerOptions, style: Style, below: String?): List<String> {
        val clustered = kind == MapLayerKind.MARKERS && options.cluster == true
        val sourceOptions = GeoJsonOptions()
        if (clustered) {
            sourceOptions.withCluster(true)
            sourceOptions.withClusterRadius((options.clusterRadius ?: 50.0).roundToInt())
            options.clusterMaxZoom?.let { sourceOptions.withClusterMaxZoom(it.roundToInt()) }
        }
        style.addSource(GeoJsonSource(name, FeatureCollection.fromFeatures(emptyList()), sourceOptions))

        val layers = mutableListOf<Layer>()
        if (kind == MapLayerKind.LINE) {
            layers.add(LineLayer("$name-line", name).withProperties(
                PropertyFactory.lineColor(parseColor(options.color) ?: Color.rgb(255, 64, 51)),
                PropertyFactory.lineWidth((options.width ?: 4.0).toFloat()),
                PropertyFactory.lineOpacity((options.opacity ?: 1.0).toFloat()),
                PropertyFactory.lineCap(Property.LINE_CAP_ROUND),
                PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND),
            ))
        } else {
            val notCluster = Expression.not(Expression.has("point_count"))
            fun single(vararg conditions: Expression): Expression =
                if (clustered) Expression.all(notCluster, *conditions) else if (conditions.size == 1) conditions[0] else Expression.all(*conditions)

            layers.add(CircleLayer("$name-dot", name).withProperties(
                PropertyFactory.circleRadius(8f),
                PropertyFactory.circleColor(Expression.get("color")),
                PropertyFactory.circleStrokeColor(Color.WHITE),
                PropertyFactory.circleStrokeWidth(2f),
            ).also { if (clustered) it.setFilter(notCluster) })

            layers.add(SymbolLayer("$name-icon", name).withProperties(
                PropertyFactory.iconImage(Expression.get("icon")),
                PropertyFactory.iconAllowOverlap(true),
                PropertyFactory.iconIgnorePlacement(true),
            ).also { it.setFilter(single(Expression.has("icon"))) })

            val fonts = styleFontNames(style)
            val label = SymbolLayer("$name-label", name).withProperties(
                PropertyFactory.textField(Expression.get("title")),
                PropertyFactory.textSize(12f),
                PropertyFactory.textColor(Color.BLACK),
                PropertyFactory.textHaloColor(Color.WHITE),
                PropertyFactory.textHaloWidth(1.2f),
                PropertyFactory.textAnchor(Property.TEXT_ANCHOR_TOP),
                PropertyFactory.textOffset(arrayOf(0f, 0.9f)),
                PropertyFactory.textOptional(true),
            )
            if (fonts != null) label.setProperties(PropertyFactory.textFont(fonts))
            label.setFilter(single(Expression.has("title")))
            layers.add(label)

            if (clustered) {
                layers.add(CircleLayer("$name-clusters", name).withProperties(
                    PropertyFactory.circleRadius(18f),
                    PropertyFactory.circleColor(Color.rgb(59, 122, 214)),
                    PropertyFactory.circleStrokeColor(Color.WHITE),
                    PropertyFactory.circleStrokeWidth(2f),
                ).also { it.setFilter(Expression.has("point_count")) })

                val count = SymbolLayer("$name-cluster-count", name).withProperties(
                    PropertyFactory.textField(Expression.toString(Expression.get("point_count"))),
                    PropertyFactory.textSize(13f),
                    PropertyFactory.textColor(Color.WHITE),
                    PropertyFactory.textAllowOverlap(true),
                    PropertyFactory.textIgnorePlacement(true),
                )
                if (fonts != null) count.setProperties(PropertyFactory.textFont(fonts))
                count.setFilter(Expression.has("point_count"))
                layers.add(count)
            }
        }

        // Always under the user puck, otherwise on top of the style.
        for (layer in layers) {
            if (below != null && style.getLayer(below) != null) style.addLayerBelow(layer, below)
            else style.addLayer(layer)
        }
        return layers.map { it.id }
    }

    /**
     * The font stack the STYLE uses most — the one its own labels prove the glyph server serves.
     * A symbol layer whose fontstack the server doesn't have leaves MapLibre waiting for glyphs
     * forever, and while it waits NOTHING of that layer's source is drawn (not the labels, not
     * the circles next to them). Count the layers, prefer an upright face over italic/bold.
     */
    fun styleFontNames(style: Style): Array<String>? {
        val counts = mutableMapOf<List<String>, Int>()
        for (layer in style.layers) {
            val symbol = layer as? SymbolLayer ?: continue
            val font = try { symbol.textFont } catch (_: Exception) { continue }
            if (!font.isValue) continue
            val names = font.value?.filterNotNull() ?: continue
            if (names.isEmpty()) continue
            val text = try { symbol.textField } catch (_: Exception) { null }
            if (text != null && text.isValue) {
                val sections = text.value?.formattedSections
                if (sections != null && sections.all { it.text.isEmpty() }) continue
            }
            counts[names] = (counts[names] ?: 0) + 1
        }
        val plain = { names: List<String> -> names.none { it.contains("Italic") || it.contains("Bold") } }
        val best = counts.entries.maxWithOrNull { a, b ->
            val pa = plain(a.key); val pb = plain(b.key)
            if (pa != pb) (if (pa) 1 else -1) else a.value.compareTo(b.value)
        } ?: return null
        return best.key.toTypedArray()
    }

    /** Meters per style px (dp) at this latitude and zoom — style units, density-independent. */
    fun metersPerStylePx(latitude: Double, zoom: Double): Double =
        40075016.686 * cos(Math.toRadians(latitude)) / (512.0 * 2.0.pow(zoom))

    // ---- user puck --------------------------------------------------------------------------

    /** Dot + accuracy halo + heading arrow on one GeoJSON source. The halo is in meters, so its
     *  px radius is recomputed as the camera moves (`rescale`). */
    class UserPuck(private val density: Float) {
        companion object {
            const val SOURCE_ID = "lecodes-user"
            const val HALO_ID = "lecodes-user-halo"
            const val DOT_ID = "lecodes-user-dot"
            const val HEADING_ID = "lecodes-user-heading"
            const val HEADING_IMAGE = "lecodes-user-heading"
            val BLUE = Color.rgb(26, 128, 255)
        }

        private var source: GeoJsonSource? = null
        private var halo: CircleLayer? = null
        private var coordinate: LatLng? = null
        private var accuracy: Double? = null

        /** App layers are inserted below this so the puck stays on top. */
        val bottomLayerId: String? get() = if (source == null) null else HALO_ID

        fun ensureLayers(style: Style) {
            if (source != null) return
            val src = GeoJsonSource(SOURCE_ID, FeatureCollection.fromFeatures(emptyList()))
            style.addSource(src)
            style.addImage(HEADING_IMAGE, arrowImage(density))

            val haloLayer = CircleLayer(HALO_ID, SOURCE_ID).withProperties(
                PropertyFactory.circleColor(Color.argb(46, 26, 128, 255)),
                PropertyFactory.circleRadius(0f),
                PropertyFactory.circlePitchAlignment(Property.CIRCLE_PITCH_ALIGNMENT_MAP),
            )
            style.addLayer(haloLayer)

            style.addLayer(SymbolLayer(HEADING_ID, SOURCE_ID).withProperties(
                PropertyFactory.iconImage(HEADING_IMAGE),
                PropertyFactory.iconRotate(Expression.get("heading")),
                PropertyFactory.iconRotationAlignment(Property.ICON_ROTATION_ALIGNMENT_MAP),
                PropertyFactory.iconAllowOverlap(true),
                PropertyFactory.iconIgnorePlacement(true),
            ).also { it.setFilter(Expression.has("heading")) })

            style.addLayer(CircleLayer(DOT_ID, SOURCE_ID).withProperties(
                PropertyFactory.circleRadius(7f),
                PropertyFactory.circleColor(BLUE),
                PropertyFactory.circleStrokeColor(Color.WHITE),
                PropertyFactory.circleStrokeWidth(2.5f),
            ))

            source = src
            halo = haloLayer
        }

        fun update(coordinate: LatLng?, accuracy: Double?, heading: Double?, map: MapLibreMap) {
            this.coordinate = coordinate
            this.accuracy = accuracy
            val src = source ?: return
            if (coordinate == null) {
                src.setGeoJson(EMPTY_COLLECTION)
                return
            }
            val feature = Feature.fromGeometry(Point.fromLngLat(coordinate.longitude, coordinate.latitude))
            if (heading != null) feature.addNumberProperty("heading", heading)
            src.setGeoJson(feature)
            rescale(map)
        }

        fun rescale(map: MapLibreMap) {
            val haloLayer = halo ?: return
            val c = coordinate ?: return
            val radius = (accuracy ?: 0.0) / metersPerStylePx(c.latitude, map.cameraPosition.zoom).coerceAtLeast(0.0001)
            // Below the dot the halo is noise; above ~ a screen it's meaningless.
            haloLayer.setProperties(PropertyFactory.circleRadius(if (radius < 10) 0f else min(radius, 600.0).toFloat()))
        }

        /** A 24×24 dp arrow head pointing up (north), rotated per feature by `heading`. */
        private fun arrowImage(density: Float): Bitmap {
            val size = (24 * density).roundToInt().coerceAtLeast(24)
            val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            // The bitmap's density is what MapLibre reads as the image's pixel ratio.
            bitmap.density = (DisplayMetrics.DENSITY_DEFAULT * density).roundToInt()
            val canvas = Canvas(bitmap)
            val s = size / 24f
            val path = Path().apply {
                moveTo(12 * s, 1 * s)
                lineTo(18 * s, 10 * s)
                lineTo(12 * s, 7.5f * s)
                lineTo(6 * s, 10 * s)
                close()
            }
            canvas.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BLUE; style = Paint.Style.FILL })
            canvas.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = s })
            return bitmap
        }
    }
}
