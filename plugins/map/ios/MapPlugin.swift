//
//  MapPlugin.swift — lecodes-plugins/map
//
//  The "map" view over maplibre-native (SPM product `MapLibre`). WHEN and WITH WHAT to show it
//  is the app's code; the calls, their arguments and the events are MapView.gen.swift, generated
//  from contract.d.ts.
//
//  Deliberately NOT here: MapLibre's location component (`showsUserLocation` stays false, the
//  puck is our own GeoJSON layer fed by the app), attribution/logo/compass chrome, and any
//  permission prompt — an app with `map` but without `geolocation` has no location story.
//
//  Threading: MapLibre is main-thread-only, and so is every call the app makes.
//

import UIKit
import CoreLocation
import MapLibre
import LeCodes

public enum LeCodesMapPlugin {

    public static let pluginId = "map"

    public static func register(in engine: LeCodesEngine) {
        MapViewChannel.register(in: engine) { params, events in MapViewInstance(params, events) }
    }
}

/// MLNMapView that re-resolves a percentage content inset on layout (`setPadding` may run before
/// the view has a size) and reports taps to its owner.
final class LeCodesMapView: MLNMapView {
    var onLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}

final class MapViewInstance: NSObject, MapViewPlugin, MLNMapViewDelegate {

    private let mapView: LeCodesMapView
    private let events: MapViewEvents
    private var style: MLNStyle?
    private var ready = false

    /// Sources the app manages through the layer API (name → how it was created). Style-declared
    /// sources are recorded as `styleOwned` — their layers are used as-is and only data flows.
    private var managed: [String: MapLayers.Managed] = [:]
    /// The last `setPadding` spec (px numbers or "NN%" strings), re-resolved on layout.
    private var paddingSpec: MapPadding?
    private var user = MapLayers.UserPuck()

    var view: UIView { mapView }

    /// What the map shows when the app gave no usable style (an `error` event follows).
    private static let blankStyle = #"{"version":8,"sources":{},"layers":[]}"#

    init(_ params: MapParams, _ events: MapViewEvents) {
        self.events = events
        // The style goes in at CONSTRUCTION, never as a property afterwards: an MLNMapView built
        // from a bare frame starts loading its OWN default style, and that load can finish after
        // the app's style is set — `didFinishLoading` then fires for a style that is about to be
        // replaced, the app's layers land in it, and the map ends up correct but empty. One style,
        // one load. `styleJson` (a bundled asset(), a file the app read, an inline style object,
        // all resolved to text by the SDK wrapper) wins over `style`, a URL the map fetches itself.
        // A style given as JSON has no base URL, so every url inside it must be absolute
        // (maplibre-native resolves no relative ones either way).
        var styleError: String?
        if let json = params.styleJson {
            // `styleJSON` raises an ObjC exception on invalid JSON, which Swift cannot catch.
            if (try? JSONSerialization.jsonObject(with: Data(json.utf8))) != nil {
                self.mapView = LeCodesMapView(frame: .zero, styleJSON: json)
            } else {
                styleError = "MapView: the style is not valid JSON"
                self.mapView = LeCodesMapView(frame: .zero, styleJSON: Self.blankStyle)
            }
        } else if let style = params.style, let url = URL(string: style) {
            self.mapView = LeCodesMapView(frame: .zero, styleURL: url)
        } else {
            styleError = "MapView: `style` must be a URL or a style JSON"
            self.mapView = LeCodesMapView(frame: .zero, styleJSON: Self.blankStyle)
        }
        super.init()
        if let styleError { events.error(message: styleError) }

        let map = mapView
        map.showsUserLocation = false
        map.logoView.isHidden = true
        map.attributionButton.isHidden = true
        map.compassView.isHidden = true
        map.allowsTilting = params.tilt ?? false
        map.allowsRotating = params.rotate ?? true
        if let minZoom = params.minZoom { map.minimumZoomLevel = minZoom }
        if let maxZoom = params.maxZoom { map.maximumZoomLevel = maxZoom }

        if let center = MapLayers.coordinate(params.center) {
            map.setCenter(center, zoomLevel: params.zoom ?? 12, direction: params.bearing ?? 0, animated: false)
        } else if let zoom = params.zoom {
            map.zoomLevel = zoom
        }
        if let pitch = params.pitch, pitch > 0 {
            let camera = map.camera
            camera.pitch = pitch
            map.setCamera(camera, animated: false)
        }

        map.delegate = self
        map.onLayout = { [weak self] in self?.applyPadding() }

        // One single tap → hit-test our sources → `tap`. Wait for MapLibre's own double-tap
        // (zoom) so a double tap doesn't also count as a tap.
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        for recognizer in map.gestureRecognizers ?? [] {
            if let existing = recognizer as? UITapGestureRecognizer, existing.numberOfTapsRequired == 2 {
                tap.require(toFail: existing)
            }
        }
        map.addGestureRecognizer(tap)
    }

    // MARK: - MapViewPlugin

    func destroy() {
        mapView.delegate = nil
        mapView.onLayout = nil
        mapView.removeFromSuperview()
    }

    func ensureLayer(_ source: String, _ kind: MapLayerKind, _ options: MapLayerOptions?, _ reply: Reply<Void, MapViewCode>) {
        settle(reply) { try self.ensureLayer(source, kind: kind, options: options ?? MapLayerOptions()) }
    }

    func removeLayer(_ source: String, _ reply: Reply<Void, MapViewCode>) {
        removeLayer(source)
        reply.resolve()
    }

    func setData(_ source: String, _ geojson: Any, _ reply: Reply<Void, MapViewCode>) {
        settle(reply) { try self.setData(source, geojson) }
    }

    func flyTo(_ center: (Double, Double), _ options: MapCameraMove?, _ reply: Reply<Void, MapViewCode>) {
        move(center, options, animated: true, reply)
    }

    func jumpTo(_ center: (Double, Double), _ options: MapCameraMove?, _ reply: Reply<Void, MapViewCode>) {
        move(center, options, animated: false, reply)
    }

    func fitPoints(_ points: [(Double, Double)], _ options: MapFitOptions?, _ reply: Reply<Void, MapViewCode>) {
        let coordinates = points.compactMap { MapLayers.coordinate($0) }
        guard !coordinates.isEmpty else { return reply.reject(.noPoints) }
        fitPoints(coordinates, options: options ?? MapFitOptions())
        reply.resolve()
    }

    func setPadding(_ padding: MapPadding, _ reply: Reply<Void, MapViewCode>) {
        paddingSpec = padding
        applyPadding()
        reply.resolve()
    }

    func getCamera(_ reply: Reply<MapCamera, MapViewCode>) {
        reply.resolve(cameraPayload())
    }

    func setUserLocation(_ lngLat: (Double, Double)?, _ options: MapUserLocationOptions?, _ reply: Reply<Void, MapViewCode>) {
        setUserLocation(MapLayers.coordinate(lngLat), accuracy: options?.accuracy, heading: options?.heading)
        reply.resolve()
    }

    private func move(_ center: (Double, Double), _ options: MapCameraMove?, animated: Bool, _ reply: Reply<Void, MapViewCode>) {
        guard let coordinate = MapLayers.coordinate(center) else { return reply.fail("the latitude \(center.1) is off the globe") }
        moveCamera(to: coordinate, options: options ?? MapCameraMove(), animated: animated)
        reply.resolve()
    }

    /// Run a method that throws and settle its reply: a style that has not loaded is the contract's
    /// `notReady`, anything else is a message.
    private func settle(_ reply: Reply<Void, MapViewCode>, _ body: () throws -> Void) {
        do {
            try body()
            reply.resolve()
        } catch MapError.notReady {
            reply.reject(.notReady)
        } catch {
            reply.fail("\(error)")
        }
    }

    // MARK: - Methods

    private func setData(_ name: String, _ geojson: Any) throws {
        guard let style else { throw MapError.notReady }
        guard let source = style.source(withIdentifier: name) as? MLNShapeSource else {
            throw MapError.message("unknown GeoJSON source \"\(name)\" — call ensureLayer / map.markers(name) first, or declare it in the style")
        }
        var payload = geojson
        if case .defaults(let kind, _)? = managed[name], kind == .markers {
            payload = MapLayers.withMarkerDefaults(geojson)
        }
        let data = try JSONSerialization.data(withJSONObject: payload)
        source.shape = try MLNShape(data: data, encoding: String.Encoding.utf8.rawValue)
    }

    private func ensureLayer(_ name: String, kind: MapLayerKind, options: MapLayerOptions) throws {
        guard let style else { throw MapError.notReady }
        if managed[name] != nil { return }
        if style.source(withIdentifier: name) != nil {
            managed[name] = .styleOwned
            return
        }
        let created = MapLayers.addDefaultLayers(name, kind: kind, options: options, to: style, below: user.bottomLayerId)
        managed[name] = .defaults(kind: kind, layerIds: created)
    }

    private func removeLayer(_ name: String) {
        guard let style, let entry = managed.removeValue(forKey: name) else { return }
        if case .defaults(_, let layerIds) = entry {
            for id in layerIds { if let layer = style.layer(withIdentifier: id) { style.removeLayer(layer) } }
            if let source = style.source(withIdentifier: name) { style.removeSource(source) }
        } else if let source = style.source(withIdentifier: name) as? MLNShapeSource {
            source.shape = MLNShapeCollectionFeature(shapes: [])
        }
    }

    // MARK: - Camera

    private func moveCamera(to center: CLLocationCoordinate2D, options: MapCameraMove, animated: Bool) {
        let zoom = options.zoom ?? mapView.zoomLevel
        let pitch = options.pitch ?? mapView.camera.pitch
        let bearing = options.bearing ?? mapView.direction
        let altitude = MLNAltitudeForZoomLevel(zoom, pitch, center.latitude, mapView.frame.size)
        let camera = MLNMapCamera(lookingAtCenter: center, altitude: altitude, pitch: pitch, heading: bearing)
        if animated {
            let duration = (options.duration ?? 600) / 1000
            mapView.fly(to: camera, withDuration: duration, completionHandler: nil)
        } else {
            mapView.setCamera(camera, animated: false)
        }
    }

    private func fitPoints(_ points: [CLLocationCoordinate2D], options: MapFitOptions) {
        let animate = options.animate ?? true
        let edge = MapLayers.insets(options.padding, in: mapView.bounds.size)
        // A single point has no extent: fit would zoom to the maximum, so cap it.
        let maxZoom = options.maxZoom ?? (points.count == 1 ? 16 : Double.infinity)

        var minLat = 90.0, maxLat = -90.0, minLng = 180.0, maxLng = -180.0
        for p in points {
            minLat = min(minLat, p.latitude); maxLat = max(maxLat, p.latitude)
            minLng = min(minLng, p.longitude); maxLng = max(maxLng, p.longitude)
        }
        let bounds = MLNCoordinateBounds(sw: CLLocationCoordinate2D(latitude: minLat, longitude: minLng),
                                         ne: CLLocationCoordinate2D(latitude: maxLat, longitude: maxLng))
        let camera = mapView.cameraThatFitsCoordinateBounds(bounds, edgePadding: edge)
        let zoom = MLNZoomLevelForAltitude(camera.altitude, camera.pitch, camera.centerCoordinate.latitude, mapView.frame.size)
        if zoom > maxZoom {
            camera.altitude = MLNAltitudeForZoomLevel(maxZoom, camera.pitch, camera.centerCoordinate.latitude, mapView.frame.size)
        }
        if animate {
            mapView.fly(to: camera, withDuration: 0.6, completionHandler: nil)
        } else {
            mapView.setCamera(camera, animated: false)
        }
    }

    private func applyPadding() {
        let insets = MapLayers.insets(paddingSpec, in: mapView.bounds.size)
        if mapView.contentInset != insets {
            mapView.contentInset = insets
        }
    }

    private func cameraPayload() -> MapCamera {
        let c = mapView.centerCoordinate
        return MapCamera(center: (c.longitude, c.latitude), zoom: mapView.zoomLevel,
                         bearing: mapView.direction, pitch: Double(mapView.camera.pitch))
    }

    // MARK: - User puck

    private func setUserLocation(_ coordinate: CLLocationCoordinate2D?, accuracy: Double?, heading: Double?) {
        guard let style else { return }
        user.ensureLayers(in: style)
        user.update(coordinate: coordinate, accuracy: accuracy, heading: heading, metersPerPoint: metersPerPoint)
    }

    private func metersPerPoint(_ latitude: CLLocationDegrees) -> Double {
        mapView.metersPerPoint(atLatitude: latitude)
    }

    // MARK: - MLNMapViewDelegate

    func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
        styleLoaded(style)
    }

    /// Fires on the first completed frame. A style handed over as JSON is parsed IMMEDIATELY —
    /// before this instance becomes the map's delegate — so `didFinishLoadingStyle` for it is
    /// missed entirely; this is where we notice that the style is up. Not an alternative path:
    /// the SDK wrapper treats every `ready` the same, and a later style reload still comes
    /// through the delegate method above.
    func mapViewDidFinishLoadingMap(_ mapView: MLNMapView) {
        guard !ready, let style = mapView.style else { return }
        styleLoaded(style)
    }

    private func styleLoaded(_ style: MLNStyle) {
        self.style = style
        // A style (re)load drops every runtime source/layer — the wrapper re-applies them on `ready`.
        managed.removeAll()
        user = MapLayers.UserPuck()
        ready = true
        events.ready()
    }

    func mapViewDidFailLoadingMap(_ mapView: MLNMapView, withError error: Error) {
        events.error(message: error.localizedDescription)
    }

    func mapView(_ mapView: MLNMapView, regionIsChangingWith reason: MLNCameraChangeReason) {
        user.rescale(metersPerPoint: metersPerPoint)
    }

    func mapView(_ mapView: MLNMapView, regionDidChangeWith reason: MLNCameraChangeReason, animated: Bool) {
        user.rescale(metersPerPoint: metersPerPoint)
        guard ready else { return }
        events.moveEnd(cameraPayload())
    }

    // MARK: - Taps

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        guard gesture.state == .ended, let style else { return }
        let point = gesture.location(in: mapView)
        let coordinate = mapView.convert(point, toCoordinateFrom: mapView)
        var tap = MapTap(lngLat: (coordinate.longitude, coordinate.latitude), point: (Double(point.x), Double(point.y)))

        // Hit-test by SOURCE: every rendered layer drawing one of the app's sources counts,
        // whether the style declared it or the plugin built the defaults.
        for name in managed.keys {
            let layerIds = style.layers.compactMap { layer -> String? in
                guard let fg = layer as? MLNForegroundStyleLayer, fg.sourceIdentifier == name else { return nil }
                return layer.identifier
            }
            guard !layerIds.isEmpty else { continue }
            let features = mapView.visibleFeatures(at: point, styleLayerIdentifiers: Set(layerIds))
            guard let feature = features.first else { continue }

            // A cluster tap zooms to the level where it splits — no event.
            if let cluster = feature as? MLNPointFeatureCluster,
               let source = style.source(withIdentifier: name) as? MLNShapeSource {
                let zoom = source.zoomLevel(forExpanding: cluster)
                mapView.setCenter(cluster.coordinate, zoomLevel: zoom, animated: true)
                return
            }

            tap.feature = MapFeature(source: name, id: MapLayers.featureId(feature), properties: MapLayers.properties(feature))
            events.tap(tap)
            return
        }
        events.tap(tap)
    }
}

enum MapError: Error, CustomStringConvertible {
    case notReady
    case message(String)

    var description: String {
        switch self {
        case .notReady: return "the style hasn't loaded yet"
        case .message(let s): return s
        }
    }
}
