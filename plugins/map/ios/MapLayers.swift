//
//  MapLayers.swift — lecodes-plugins/map
//
//  The style-side helpers behind MapViewInstance: default layers for app-created sources (a
//  colored dot + optional icon + optional label, clusters on request; a line), the user puck
//  (dot + accuracy halo + heading arrow — our own GeoJSON source, never MapLibre's location
//  component), and JSON <-> MapLibre conversions.
//
//  The LOOK of the defaults is deliberately plain: an app that wants designed markers declares
//  the source in its style JSON and the plugin only pushes data (`Managed.styleOwned`).
//

import UIKit
import CoreLocation
import MapLibre

enum MapLayers {
    enum Managed {
        /// The style declares the source; its layers are used untouched.
        case styleOwned
        /// The plugin created the source and these layers.
        case defaults(kind: MapLayerKind, layerIds: [String])
    }

    static let defaultMarkerColor = "#DD4B40"

    // MARK: - JSON helpers

    /// `[lng, lat]` → coordinate; a latitude off the globe → nil.
    static func coordinate(_ lngLat: (Double, Double)?) -> CLLocationCoordinate2D? {
        guard let (lng, lat) = lngLat, lat >= -90, lat <= 90 else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }

    /// Per-edge padding (px numbers / `"NN%"` strings) → insets in points for a view of `size`.
    static func insets(_ padding: MapPadding?, in size: CGSize) -> UIEdgeInsets {
        func edge(_ inset: MapInset?, _ extent: CGFloat) -> CGFloat {
            switch inset {
            case .number(let n)?: return CGFloat(n)
            case .string(let s)?:
                if s.hasSuffix("%"), let pct = Double(s.dropLast()) { return extent * CGFloat(pct / 100) }
                return 0
            case nil: return 0
            }
        }
        return UIEdgeInsets(top: edge(padding?.top, size.height), left: edge(padding?.left, size.width),
                            bottom: edge(padding?.bottom, size.height), right: edge(padding?.right, size.width))
    }

    /// The padding of a fit: one number for every edge, or per edge.
    static func insets(_ padding: MapFitOptionsPadding?, in size: CGSize) -> UIEdgeInsets {
        switch padding {
        case .number(let all)?: return UIEdgeInsets(top: all, left: all, bottom: all, right: all)
        case .mapPadding(let edges)?: return insets(edges, in: size)
        case nil: return .zero
        }
    }

    /// Plugin-built marker layers read `color` — fill the default where an item didn't say.
    static func withMarkerDefaults(_ geojson: Any) -> Any {
        guard var collection = geojson as? [String: Any], var features = collection["features"] as? [[String: Any]] else { return geojson }
        for i in features.indices {
            var props = features[i]["properties"] as? [String: Any] ?? [:]
            if props["color"] == nil { props["color"] = defaultMarkerColor }
            features[i]["properties"] = props
        }
        collection["features"] = features
        return collection
    }

    static func featureId(_ feature: MLNFeature) -> MapFeatureId? {
        guard let id = feature.attribute(forKey: "id") ?? feature.identifier else { return nil }
        if let text = id as? String { return .string(text) }
        if let number = id as? NSNumber { return .number(number.doubleValue) }
        return .string(String(describing: id))
    }

    /// A feature's attributes as the JSON object the app gets.
    static func properties(_ feature: MLNFeature) -> [String: Any] {
        feature.attributes.mapValues(jsonSafe)
    }

    /// Feature attributes come back as NSNumber/NSString/NSNull/arrays/dicts — pass through
    /// what JSONSerialization accepts, stringify the rest.
    static func jsonSafe(_ value: Any) -> Any {
        switch value {
        case let dict as [String: Any]: return dict.mapValues(jsonSafe)
        case let array as [Any]: return array.map(jsonSafe)
        case is NSNumber, is String, is NSNull: return value
        default: return String(describing: value)
        }
    }

    // MARK: - Default layers

    /// Create the source + layers for an app-managed name. Returns the layer ids (for removal).
    static func addDefaultLayers(_ name: String, kind: MapLayerKind, options: MapLayerOptions, to style: MLNStyle, below topId: String?) -> [String] {
        var sourceOptions: [MLNShapeSourceOption: Any] = [:]
        if kind == .markers, options.cluster == true {
            sourceOptions[.clustered] = true
            sourceOptions[.clusterRadius] = options.clusterRadius ?? 50
            if let maxZoom = options.clusterMaxZoom { sourceOptions[.maximumZoomLevelForClustering] = maxZoom }
        }
        let source = MLNShapeSource(identifier: name, shape: MLNShapeCollectionFeature(shapes: []), options: sourceOptions.isEmpty ? nil : sourceOptions)
        style.addSource(source)

        var layers: [MLNStyleLayer] = []
        if kind == .line {
            let line = MLNLineStyleLayer(identifier: "\(name)-line", source: source)
            line.lineColor = NSExpression(forConstantValue: color(options.color) ?? UIColor(red: 1, green: 0.25, blue: 0.2, alpha: 1))
            line.lineWidth = NSExpression(forConstantValue: options.width ?? 4)
            line.lineOpacity = NSExpression(forConstantValue: options.opacity ?? 1)
            line.lineCap = NSExpression(forConstantValue: "round")
            line.lineJoin = NSExpression(forConstantValue: "round")
            layers.append(line)
        } else {
            let clustered = sourceOptions[.clustered] as? Bool == true

            let probe = MLNCircleStyleLayer(identifier: "\(name)-probe", source: source)
            probe.circleRadius = NSExpression(forConstantValue: 4)
            probe.circleColor = NSExpression(forConstantValue: UIColor.magenta)
            layers.append(probe)

            let dot = MLNCircleStyleLayer(identifier: "\(name)-dot", source: source)
            dot.circleRadius = NSExpression(forConstantValue: 8)
            dot.circleColor = NSExpression(forKeyPath: "color")
            dot.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
            dot.circleStrokeWidth = NSExpression(forConstantValue: 2)
            if clustered { dot.predicate = NSPredicate(format: "point_count == nil") }
            layers.append(dot)

            let icon = MLNSymbolStyleLayer(identifier: "\(name)-icon", source: source)
            icon.iconImageName = NSExpression(forKeyPath: "icon")
            icon.iconAllowsOverlap = NSExpression(forConstantValue: true)
            icon.iconIgnoresPlacement = NSExpression(forConstantValue: true)
            icon.predicate = clustered ? NSPredicate(format: "point_count == nil AND icon != nil") : NSPredicate(format: "icon != nil")
            layers.append(icon)

            let fonts = styleFontNames(style)
            let label = MLNSymbolStyleLayer(identifier: "\(name)-label", source: source)
            label.text = NSExpression(forKeyPath: "title")
            if let fonts { label.textFontNames = NSExpression(forConstantValue: fonts) }
            label.textFontSize = NSExpression(forConstantValue: 12)
            label.textColor = NSExpression(forConstantValue: UIColor.black)
            label.textHaloColor = NSExpression(forConstantValue: UIColor.white)
            label.textHaloWidth = NSExpression(forConstantValue: 1.2)
            label.textAnchor = NSExpression(forConstantValue: NSValue(mlnTextAnchor: .top))
            label.textOffset = NSExpression(forConstantValue: NSValue(cgVector: CGVector(dx: 0, dy: 0.9)))
            label.textOptional = NSExpression(forConstantValue: true)
            label.predicate = clustered ? NSPredicate(format: "point_count == nil AND title != nil") : NSPredicate(format: "title != nil")
            layers.append(label)

            if clustered {
                let circle = MLNCircleStyleLayer(identifier: "\(name)-clusters", source: source)
                circle.circleRadius = NSExpression(forConstantValue: 18)
                circle.circleColor = NSExpression(forConstantValue: UIColor(red: 0.23, green: 0.48, blue: 0.84, alpha: 1))
                circle.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
                circle.circleStrokeWidth = NSExpression(forConstantValue: 2)
                circle.predicate = NSPredicate(format: "point_count != nil")
                layers.append(circle)

                let count = MLNSymbolStyleLayer(identifier: "\(name)-cluster-count", source: source)
                count.text = NSExpression(format: "CAST(point_count, 'NSString')")
                if let fonts = styleFontNames(style) { count.textFontNames = NSExpression(forConstantValue: fonts) }
                count.textFontSize = NSExpression(forConstantValue: 13)
                count.textColor = NSExpression(forConstantValue: UIColor.white)
                count.textAllowsOverlap = NSExpression(forConstantValue: true)
                count.textIgnoresPlacement = NSExpression(forConstantValue: true)
                count.predicate = NSPredicate(format: "point_count != nil")
                layers.append(count)
            }
        }

        // Always under the user puck, otherwise on top of the style.
        for layer in layers {
            if let topId, let top = style.layer(withIdentifier: topId) {
                style.insertLayer(layer, below: top)
            } else {
                style.addLayer(layer)
            }
        }
        return layers.map { $0.identifier }
    }

    /// A font stack the STYLE already uses. A symbol layer with no `textFontNames` asks for
    /// MapLibre's default stack, and a style whose glyph server doesn't have it fails the whole
    /// source: no labels, and no circles either — the layers of that source render nothing.
    /// The font stack the style uses MOST — the one its own labels prove the glyph server serves.
    ///
    /// This matters more than it looks: a symbol layer whose fontstack the server doesn't have
    /// leaves MapLibre waiting for glyphs forever, and while it waits NOTHING of that layer's
    /// source is drawn — not the labels, not the circles next to them. Picking a stack out of the
    /// first symbol layer is not enough (an icon-only layer, a one-way arrow say, can name a stack
    /// nobody ever fetches — `Open Sans Regular,Arial Unicode MS Regular` 404s on OpenFreeMap while
    /// every label there is Noto Sans), so count the layers and take the winner, preferring an
    /// upright face over italic/bold.
    static func styleFontNames(_ style: MLNStyle) -> [String]? {
        var counts: [[String]: Int] = [:]
        for layer in style.layers {
            guard let symbol = layer as? MLNSymbolStyleLayer, let fontExpression = symbol.textFontNames,
                  fontExpression.expressionType == .constantValue || fontExpression.expressionType == .aggregate,
                  let raw = fontExpression.constantValue as? [Any] else { continue }
            // `constantValue` throws on anything but a constant, and a text field is often an
            // expression — ask only when it IS one, to skip layers whose text is empty.
            if let text = symbol.text, text.expressionType == .constantValue,
               let constant = text.constantValue as? String, constant.isEmpty { continue }
            let names = raw.compactMap { element -> String? in
                if let name = element as? String { return name }
                return (element as? NSExpression)?.constantValue as? String
            }
            if !names.isEmpty { counts[names, default: 0] += 1 }
        }
        let plain = { (names: [String]) in !names.contains { $0.contains("Italic") || $0.contains("Bold") } }
        return counts.max { a, b in
            if plain(a.key) != plain(b.key) { return plain(b.key) }
            return a.value < b.value
        }?.key
    }

    static func color(_ hex: String?) -> UIColor? {
        guard let hex else { return nil }
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6 || s.count == 8, let value = UInt64(s, radix: 16) else { return nil }
        let a = s.count == 8 ? CGFloat(value & 0xFF) / 255 : 1
        let shift: UInt64 = s.count == 8 ? 8 : 0
        return UIColor(red: CGFloat((value >> (16 + shift)) & 0xFF) / 255,
                       green: CGFloat((value >> (8 + shift)) & 0xFF) / 255,
                       blue: CGFloat((value >> shift) & 0xFF) / 255, alpha: a)
    }

    // MARK: - User puck

    /// Dot + accuracy halo + heading arrow on one GeoJSON source. The halo is in meters, so its
    /// pixel radius is recomputed as the camera moves (`rescale`).
    struct UserPuck {
        static let sourceId = "lecodes-user"
        static let haloId = "lecodes-user-halo"
        static let dotId = "lecodes-user-dot"
        static let headingId = "lecodes-user-heading"
        static let headingImage = "lecodes-user-heading"

        private var source: MLNShapeSource?
        private var halo: MLNCircleStyleLayer?
        private var coordinate: CLLocationCoordinate2D?
        private var accuracy: Double?

        /// App layers are inserted below this so the puck stays on top.
        var bottomLayerId: String? { source == nil ? nil : Self.haloId }

        mutating func ensureLayers(in style: MLNStyle) {
            guard source == nil else { return }
            let source = MLNShapeSource(identifier: Self.sourceId, shape: MLNShapeCollectionFeature(shapes: []), options: nil)
            style.addSource(source)
            style.setImage(Self.arrowImage(), forName: Self.headingImage)

            let halo = MLNCircleStyleLayer(identifier: Self.haloId, source: source)
            halo.circleColor = NSExpression(forConstantValue: UIColor(red: 0.1, green: 0.5, blue: 1, alpha: 0.18))
            halo.circleRadius = NSExpression(forConstantValue: 0)
            halo.circlePitchAlignment = NSExpression(forConstantValue: "map")
            style.addLayer(halo)

            let heading = MLNSymbolStyleLayer(identifier: Self.headingId, source: source)
            heading.iconImageName = NSExpression(forConstantValue: Self.headingImage)
            heading.iconRotation = NSExpression(forKeyPath: "heading")
            heading.iconRotationAlignment = NSExpression(forConstantValue: "map")
            heading.iconAllowsOverlap = NSExpression(forConstantValue: true)
            heading.iconIgnoresPlacement = NSExpression(forConstantValue: true)
            heading.predicate = NSPredicate(format: "heading != nil")
            style.addLayer(heading)

            let dot = MLNCircleStyleLayer(identifier: Self.dotId, source: source)
            dot.circleRadius = NSExpression(forConstantValue: 7)
            dot.circleColor = NSExpression(forConstantValue: UIColor(red: 0.1, green: 0.5, blue: 1, alpha: 1))
            dot.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
            dot.circleStrokeWidth = NSExpression(forConstantValue: 2.5)
            style.addLayer(dot)

            self.source = source
            self.halo = halo
        }

        mutating func update(coordinate: CLLocationCoordinate2D?, accuracy: Double?, heading: Double?, metersPerPoint: (CLLocationDegrees) -> Double) {
            self.coordinate = coordinate
            self.accuracy = accuracy
            guard let source else { return }
            guard let coordinate else {
                source.shape = MLNShapeCollectionFeature(shapes: [])
                return
            }
            let point = MLNPointFeature()
            point.coordinate = coordinate
            if let heading { point.attributes = ["heading": heading] }
            source.shape = point
            rescale(metersPerPoint: metersPerPoint)
        }

        func rescale(metersPerPoint: (CLLocationDegrees) -> Double) {
            guard let halo, let coordinate else { return }
            let radius = (accuracy ?? 0) / max(metersPerPoint(coordinate.latitude), 0.0001)
            // Below the dot the halo is noise; above ~ a screen it's meaningless.
            halo.circleRadius = NSExpression(forConstantValue: radius < 10 ? 0 : min(radius, 600))
        }

        /// A 24×24 arrow head pointing up (north), rotated per feature by `heading`.
        static func arrowImage() -> UIImage {
            let size = CGSize(width: 24, height: 24)
            return UIGraphicsImageRenderer(size: size).image { ctx in
                let path = UIBezierPath()
                path.move(to: CGPoint(x: 12, y: 1))
                path.addLine(to: CGPoint(x: 18, y: 10))
                path.addLine(to: CGPoint(x: 12, y: 7.5))
                path.addLine(to: CGPoint(x: 6, y: 10))
                path.close()
                UIColor(red: 0.1, green: 0.5, blue: 1, alpha: 1).setFill()
                path.fill()
                ctx.cgContext.setStrokeColor(UIColor.white.cgColor)
                ctx.cgContext.setLineWidth(1)
                path.stroke()
            }
        }
    }
}
