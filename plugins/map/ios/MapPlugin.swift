//
//  MapPlugin.swift — lecodes-plugins/map
//
//  The plugin's two surfaces over maplibre-native, one map class under both (MapController.swift):
//   - the VIEW "map" (MapViewInstance): the fullscreen map the app pushes or opens; its params are
//     read once, at creation, and its view is the map view itself;
//   - the HOST NODE "map" (MapNodeInstance): the map as a box of a screen's layout, laid out and
//     painted by the core's holder (UINodeHost); its props are LIVE.
//  WHEN and WITH WHAT to show either is the app's code; the calls, their arguments and the events
//  are MapViewPlugin.gen.swift, generated from contract.d.ts (one file for both surfaces: the
//  contract's types once, the View's channel, the node's glue).
//
//  The node's rules:
//   - Its props arrive one by one (the holder hands each write over, `kind` first), so the map is
//     made at the END of the node's first commit (a main-queue turn after its first prop), from
//     every prop that commit wrote — the style before anything loads: maplibre-native must get its
//     style at construction (MapController.init says why), so the map cannot exist at the instance's
//     creation. The instance's view is a plain box (MapNodeBox) that takes the map view in then.
//   - Later commits are applied the same way, once per commit: a style write reloads the style once
//     (and only when it differs from the one shown — `ready` fires again then), the camera props
//     written (`center` / `zoom` / `bearing` / `pitch`) are ONE jump to what was written with the
//     rest of the camera kept, the zoom range and the gestures are set.
//   - A call flushes what is pending first: it sees every prop written before it (and makes the map
//     when it comes before the first turn — a call the runtime holds until the node's commit).
//   - `destroy` (the node released) tears the map down; a flush after it does nothing.
//

import UIKit
import LeCodes

public enum LeCodesMapPlugin {

    public static let pluginId = "map"

    public static func register(in engine: LeCodesEngine) {
        MapViewChannel.register(in: engine) { params, events in MapViewInstance(params, events) }
        UIMapNodeGlue.register(in: engine) { events in MapNodeInstance(events) }
    }
}

// MARK: - The View

/// The view "map": a MapController made from the View's params, its map view the View's.
final class MapViewInstance: MapViewPlugin {
    private let map: MapController

    var view: UIView { map.mapView }

    init(_ params: MapParams, _ events: MapViewEvents) {
        map = MapController(params, events)
    }

    func destroy() { map.destroy() }

    func ensureLayer(_ source: String, _ kind: MapLayerKind, _ options: MapLayerOptions?, _ reply: Reply<Void, MapViewCode>) {
        map.ensureLayer(source, kind, options, reply)
    }
    func removeLayer(_ source: String, _ reply: Reply<Void, MapViewCode>) { map.removeLayer(source, reply) }
    func setData(_ source: String, _ geojson: Any, _ reply: Reply<Void, MapViewCode>) { map.setData(source, geojson, reply) }
    func flyTo(_ center: (Double, Double), _ options: MapCameraMove?, _ reply: Reply<Void, MapViewCode>) { map.flyTo(center, options, reply) }
    func jumpTo(_ center: (Double, Double), _ options: MapCameraMove?, _ reply: Reply<Void, MapViewCode>) { map.jumpTo(center, options, reply) }
    func fitPoints(_ points: [(Double, Double)], _ options: MapFitOptions?, _ reply: Reply<Void, MapViewCode>) {
        map.fitPoints(points, options, reply)
    }
    func setPadding(_ padding: MapPadding, _ reply: Reply<Void, MapViewCode>) { map.setPadding(padding, reply) }
    func getCamera(_ reply: Reply<MapCamera, MapViewCode>) { map.getCamera(reply) }
    func setUserLocation(_ lngLat: (Double, Double)?, _ options: MapUserLocationOptions?, _ reply: Reply<Void, MapViewCode>) {
        map.setUserLocation(lngLat, options, reply)
    }
}

// MARK: - The host node

/// The host node "map": a box of the layout holding a MapController (the header's rules).
final class MapNodeInstance: UIMapNodeInstance {
    /// The props written since the last flush.
    private struct Dirty: OptionSet {
        let rawValue: Int
        static let style = Dirty(rawValue: 1 << 0)
        static let center = Dirty(rawValue: 1 << 1)
        static let zoom = Dirty(rawValue: 1 << 2)
        static let bearing = Dirty(rawValue: 1 << 3)
        static let pitch = Dirty(rawValue: 1 << 4)
        static let zoomRange = Dirty(rawValue: 1 << 5)
        static let gestures = Dirty(rawValue: 1 << 6)
        static let camera: Dirty = [.center, .zoom, .bearing, .pitch]
    }

    private let box = MapNodeBox()
    var view: UIView { box }
    private let events: UIMapNodeEvents
    /// Every prop as written last, in the View's params' fields (the prop `styleUrl` is `style`):
    /// what the map is made from.
    private var props = MapParams()
    private var dirty: Dirty = []
    private var flushQueued = false
    private var map: MapController?
    /// The style the map shows: a write of the same one reloads nothing.
    private var shownStyle: (url: String?, json: String?) = (nil, nil)
    private var destroyed = false

    init(_ events: UIMapNodeEvents) { self.events = events }

    func set(styleUrl: String?) { props.style = styleUrl; mark(.style) }
    func set(styleJson: String?) { props.styleJson = styleJson; mark(.style) }
    func set(center: (Double, Double)?) { props.center = center; mark(.center) }
    func set(zoom: Double?) { props.zoom = zoom; mark(.zoom) }
    func set(minZoom: Double?) { props.minZoom = minZoom; mark(.zoomRange) }
    func set(maxZoom: Double?) { props.maxZoom = maxZoom; mark(.zoomRange) }
    func set(bearing: Double?) { props.bearing = bearing; mark(.bearing) }
    func set(pitch: Double?) { props.pitch = pitch; mark(.pitch) }
    func set(rotate: Bool?) { props.rotate = rotate; mark(.gestures) }
    func set(tilt: Bool?) { props.tilt = tilt; mark(.gestures) }

    func destroy() {
        destroyed = true
        map?.destroy()
        map = nil
    }

    /// A prop changed: applied with the rest of its commit, a main-queue turn later.
    private func mark(_ prop: Dirty) {
        dirty.insert(prop)
        guard !flushQueued else { return }
        flushQueued = true
        DispatchQueue.main.async { [weak self] in _ = self?.flush() }
    }

    /// Apply what was written since the last flush — the first one makes the map from every prop.
    /// The map; nil once destroyed.
    private func flush() -> MapController? {
        flushQueued = false
        guard !destroyed else { return nil }
        let changed = dirty
        dirty = []
        guard let map else {
            let made = MapController(props, events)
            shownStyle = (props.style, props.styleJson)
            box.adopt(made.mapView)
            map = made
            return made
        }
        if changed.contains(.style), shownStyle.url != props.style || shownStyle.json != props.styleJson {
            shownStyle = (props.style, props.styleJson)
            map.setStyle(url: props.style, json: props.styleJson)
        }
        if !changed.isDisjoint(with: .camera) {
            map.jump(center: changed.contains(.center) ? props.center : nil,
                     zoom: changed.contains(.zoom) ? props.zoom : nil,
                     bearing: changed.contains(.bearing) ? props.bearing : nil,
                     pitch: changed.contains(.pitch) ? props.pitch : nil)
        }
        if changed.contains(.zoomRange) { map.setZoomRange(min: props.minZoom, max: props.maxZoom) }
        if changed.contains(.gestures) { map.setGestures(rotate: props.rotate, tilt: props.tilt) }
        return map
    }

    // The calls see every prop written before them.

    func ensureLayer(_ source: String, _ kind: MapLayerKind, _ options: MapLayerOptions?, _ reply: Reply<Void, UIMapNodeCode>) {
        guard let map = flush() else { return reply.reject(.notReady) }
        map.ensureLayer(source, kind, options, reply)
    }
    func removeLayer(_ source: String, _ reply: Reply<Void, UIMapNodeCode>) {
        guard let map = flush() else { return reply.resolve() }
        map.removeLayer(source, reply)
    }
    func setData(_ source: String, _ geojson: Any, _ reply: Reply<Void, UIMapNodeCode>) {
        guard let map = flush() else { return reply.reject(.notReady) }
        map.setData(source, geojson, reply)
    }
    func flyTo(_ center: (Double, Double), _ options: MapCameraMove?, _ reply: Reply<Void, UIMapNodeCode>) {
        guard let map = flush() else { return reply.reject(.notReady) }
        map.flyTo(center, options, reply)
    }
    func jumpTo(_ center: (Double, Double), _ options: MapCameraMove?, _ reply: Reply<Void, UIMapNodeCode>) {
        guard let map = flush() else { return reply.reject(.notReady) }
        map.jumpTo(center, options, reply)
    }
    func fitPoints(_ points: [(Double, Double)], _ options: MapFitOptions?, _ reply: Reply<Void, UIMapNodeCode>) {
        guard let map = flush() else { return reply.reject(.notReady) }
        map.fitPoints(points, options, reply)
    }
    func setPadding(_ padding: MapPadding, _ reply: Reply<Void, UIMapNodeCode>) {
        guard let map = flush() else { return reply.reject(.notReady) }
        map.setPadding(padding, reply)
    }
    func getCamera(_ reply: Reply<MapCamera, UIMapNodeCode>) {
        guard let map = flush() else { return reply.reject(.notReady) }
        map.getCamera(reply)
    }
    func setUserLocation(_ lngLat: (Double, Double)?, _ options: MapUserLocationOptions?, _ reply: Reply<Void, UIMapNodeCode>) {
        guard let map = flush() else { return reply.reject(.notReady) }
        map.setUserLocation(lngLat, options, reply)
    }
}

/// The node's view: the map view inside at the box's bounds, from the first flush on. The holder
/// lays this box out as the node's and paints the box paint (radius, border, shadow) over it.
final class MapNodeBox: UIView {
    func adopt(_ map: UIView) {
        map.frame = bounds
        map.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(map)
    }
}
