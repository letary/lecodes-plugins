//
//  MapController.swift — lecodes-plugins/map
//
//  The ONE map behind both surfaces of the plugin (contract.d.ts): the fullscreen view "map"
//  (MapViewInstance) and the host node "map" (MapNodeInstance, a box of a screen's layout) each
//  wrap a MapController — the MLNMapView over maplibre-native (SPM product `MapLibre`), the app's
//  sources and layers, the camera, the user puck, the taps. The surfaces differ only in how the map
//  is made and changed (MapPlugin.swift): the View's params are read once, at creation; the node's
//  props are live — `setStyle`, `jump`, `setZoomRange`, `setGestures` below are theirs.
//
//  The calls are the contract's MapMethods, one set for both surfaces: generic over the surface's
//  generated code enum (MapCode), so each instance forwards them as they come. The events go
//  through the surface's generated events struct (MapEventSink).
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

/// The codes the map's calls reject with — the contract's MapMethods, the same for both surfaces:
/// each surface's generated enum has them as cases.
protocol MapCode: PluginCode {
    static var notReady: Self { get }
    static var noPoints: Self { get }
}
extension MapViewCode: MapCode {}
extension UIMapNodeCode: MapCode {}

/// What the map tells the app — the contract's MapEvents: each surface's generated events struct.
protocol MapEventSink {
    func ready()
    func tap(_ payload: MapTap)
    func moveEnd(_ payload: MapCamera)
    func error(message: String)
}
extension MapViewEvents: MapEventSink {}
extension UIMapNodeEvents: MapEventSink {}

/// MLNMapView that re-resolves a percentage content inset on layout (`setPadding` may run before
/// the view has a size) and reports taps to its owner.
final class LeCodesMapView: MLNMapView {
    var onLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}

final class MapController: NSObject, MLNMapViewDelegate {

    let mapView: LeCodesMapView
    private let events: MapEventSink
    private var style: MLNStyle?
    /// The style shown has loaded: the calls that need it go through.
    private var ready = false
    /// A style has loaded once: from then on every settled camera is reported (`moveEnd`) — a camera
    /// prop written with another style lands while that style loads, and still moved the camera.
    private var loadedOnce = false

    /// Sources the app manages through the layer API (name → how it was created). Style-declared
    /// sources are recorded as `styleOwned` — their layers are used as-is and only data flows.
    private var managed: [String: MapLayers.Managed] = [:]
    /// The last `setPadding` spec (px numbers or "NN%" strings), re-resolved on layout.
    private var paddingSpec: MapPadding?
    private var user = MapLayers.UserPuck()
    /// MapLibre's zoom range, what a cleared `minZoom` / `maxZoom` returns to.
    private let defaultZoomRange: (min: Double, max: Double)

    /// What the map shows when the app gave no usable style (an `error` event follows).
    private static let blankStyle = #"{"version":8,"sources":{},"layers":[]}"#

    private enum StyleSource {
        case url(URL)
        case json(String)
    }

    /// The style to load, and what is wrong with the app's (an `error` event): the JSON text wins
    /// over the URL; neither usable = the blank style. A style given as JSON has no base URL, so
    /// every url inside it must be absolute (maplibre-native resolves no relative ones either way).
    private static func styleSource(url: String?, json: String?) -> (StyleSource, problem: String?) {
        if let json {
            // `styleJSON` raises an ObjC exception on invalid JSON, which Swift cannot catch.
            if (try? JSONSerialization.jsonObject(with: Data(json.utf8))) != nil { return (.json(json), nil) }
            return (.json(blankStyle), "the style is not valid JSON")
        }
        if let url, let parsed = URL(string: url) { return (.url(parsed), nil) }
        return (.json(blankStyle), "the map has no style: give a URL or a style JSON")
    }

    /// The map as the View's params (or the node's first props, the same fields) say: its style, its
    /// first view, its gestures.
    init(_ params: MapParams, _ events: MapEventSink) {
        self.events = events
        // The style goes in at CONSTRUCTION, never as a property afterwards: an MLNMapView built
        // from a bare frame starts loading its OWN default style, and that load can finish after
        // the app's style is set — `didFinishLoading` then fires for a style that is about to be
        // replaced, the app's layers land in it, and the map ends up correct but empty. One style,
        // one load. `styleJson` (a bundled asset(), a file the app read, an inline style object,
        // all resolved to text by the SDK wrapper) wins over `style`, a URL the map fetches itself.
        let (source, styleError) = Self.styleSource(url: params.style, json: params.styleJson)
        let map: LeCodesMapView
        switch source {
        case .url(let url): map = LeCodesMapView(frame: .zero, styleURL: url)
        case .json(let json): map = LeCodesMapView(frame: .zero, styleJSON: json)
        }
        self.mapView = map
        defaultZoomRange = (map.minimumZoomLevel, map.maximumZoomLevel)
        super.init()
        if let styleError { events.error(message: styleError) }

        map.showsUserLocation = false
        map.logoView.isHidden = true
        map.attributionButton.isHidden = true
        map.compassView.isHidden = true
        setGestures(rotate: params.rotate, tilt: params.tilt)
        setZoomRange(min: params.minZoom, max: params.maxZoom)

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

    func destroy() {
        mapView.delegate = nil
        mapView.onLayout = nil
        mapView.removeFromSuperview()
    }

    // MARK: - What a live prop changes (the node's)

    /// Load another style, once: until it has loaded, the calls that need the style reject
    /// `notReady` (the SDK queues its own until `ready`, which fires again then and re-applies the
    /// app's layers). Only a style that differs from the one shown is given here.
    func setStyle(url: String?, json: String?) {
        let (source, problem) = Self.styleSource(url: url, json: json)
        ready = false
        style = nil
        // The delegate hears the load: a JSON style is parsed at once, inside the setter.
        switch source {
        case .url(let url): mapView.styleURL = url
        case .json(let json): mapView.styleJSON = json
        }
        if let problem { events.error(message: problem) }
    }

    /// Move the camera at once to what is given; nil keeps that part of the camera.
    func jump(center: (Double, Double)?, zoom: Double?, bearing: Double?, pitch: Double?) {
        let target = MapLayers.coordinate(center) ?? mapView.centerCoordinate
        mapView.setCenter(target, zoomLevel: zoom ?? mapView.zoomLevel, direction: bearing ?? mapView.direction, animated: false)
        if let pitch {
            let camera = mapView.camera
            camera.pitch = pitch
            mapView.setCamera(camera, animated: false)
        }
    }

    /// nil = MapLibre's own bound.
    func setZoomRange(min: Double?, max: Double?) {
        mapView.minimumZoomLevel = min ?? defaultZoomRange.min
        mapView.maximumZoomLevel = max ?? defaultZoomRange.max
    }

    /// nil = the contract's default: rotating on, tilting off.
    func setGestures(rotate: Bool?, tilt: Bool?) {
        mapView.allowsRotating = rotate ?? true
        mapView.allowsTilting = tilt ?? false
    }

    // MARK: - MapMethods

    func ensureLayer<C: MapCode>(_ source: String, _ kind: MapLayerKind, _ options: MapLayerOptions?, _ reply: Reply<Void, C>) {
        settle(reply) { try self.ensureLayer(source, kind: kind, options: options ?? MapLayerOptions()) }
    }

    func removeLayer<C: MapCode>(_ source: String, _ reply: Reply<Void, C>) {
        removeLayer(source)
        reply.resolve()
    }

    func setData<C: MapCode>(_ source: String, _ geojson: Any, _ reply: Reply<Void, C>) {
        settle(reply) { try self.setData(source, geojson) }
    }

    func flyTo<C: MapCode>(_ center: (Double, Double), _ options: MapCameraMove?, _ reply: Reply<Void, C>) {
        move(center, options, animated: true, reply)
    }

    func jumpTo<C: MapCode>(_ center: (Double, Double), _ options: MapCameraMove?, _ reply: Reply<Void, C>) {
        move(center, options, animated: false, reply)
    }

    func fitPoints<C: MapCode>(_ points: [(Double, Double)], _ options: MapFitOptions?, _ reply: Reply<Void, C>) {
        let coordinates = points.compactMap { MapLayers.coordinate($0) }
        guard !coordinates.isEmpty else { return reply.reject(.noPoints) }
        fitPoints(coordinates, options: options ?? MapFitOptions())
        reply.resolve()
    }

    func setPadding<C: MapCode>(_ padding: MapPadding, _ reply: Reply<Void, C>) {
        paddingSpec = padding
        applyPadding()
        reply.resolve()
    }

    func getCamera<C: MapCode>(_ reply: Reply<MapCamera, C>) {
        reply.resolve(cameraPayload())
    }

    func setUserLocation<C: MapCode>(_ lngLat: (Double, Double)?, _ options: MapUserLocationOptions?, _ reply: Reply<Void, C>) {
        setUserLocation(MapLayers.coordinate(lngLat), accuracy: options?.accuracy, heading: options?.heading)
        reply.resolve()
    }

    private func move<C: MapCode>(_ center: (Double, Double), _ options: MapCameraMove?, animated: Bool, _ reply: Reply<Void, C>) {
        guard let coordinate = MapLayers.coordinate(center) else { return reply.fail("the latitude \(center.1) is off the globe") }
        moveCamera(to: coordinate, options: options ?? MapCameraMove(), animated: animated)
        reply.resolve()
    }

    /// Run a method that throws and settle its reply: a style that has not loaded is the contract's
    /// `notReady`, anything else is a message.
    private func settle<C: MapCode>(_ reply: Reply<Void, C>, _ body: () throws -> Void) {
        do {
            try body()
            reply.resolve()
        } catch MapError.notReady {
            reply.reject(.notReady)
        } catch {
            reply.fail("\(error)")
        }
    }

    // MARK: - Sources and layers

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
        loadedOnce = true
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
        guard loadedOnce else { return }
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
