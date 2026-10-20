//
//  ARKitSession.swift — lecodes-plugins/ar
//
//  One AR session over ARKit, driving the app's scene through `engine.gl` and nothing else: each frame
//  (`gl.onFrame`, before the runtime's tick) the newest ARFrame's image goes into an external texture
//  shown as the scene's background through `displayTransform` (inverted: the viewport's top-left
//  normalized point → the image's), the camera's pose for the interface orientation becomes the
//  scene camera's matrix, `projectionMatrix(for:viewportSize:zNear:zFar:)` its projection, and the
//  entities the app pinned follow their ARAnchor / ARImageAnchor (an image's: a rigid pose, its size
//  the `image` event's `extent`). Planes, tracking, the light and the relocalizations go out as the
//  contract's events; plane updates are throttled here (a change over 1 cm, at most 10 a second per
//  plane). The channel is AR.gen.swift, generated from contract.d.ts; `start` arrives with the camera
//  permission granted.
//
//  `setImages` gives a running session another set of image targets: the configuration's images
//  change and the session runs it again with no reset options — ARKit keeps the world map, the
//  planes and the anchors, and goes on tracking an image still in the set (its reference is the same
//  object, so ARKit knows it is the same image).
//
//  The viewport is the scene view's (`gl.viewport(scene)`: its size in points, the display's turn),
//  read every frame: a shell may show the scene in less than the window, and a turn or a resize
//  re-makes the projection and the background's crop that frame. Before the scene is presented its
//  view has no size (the session starts during the warm render): nothing is drawn until it has one.
//

import ARKit
import CoreImage
import CoreLocation
import Foundation
import LeCodes
import UIKit
import simd

final class ARKitSession: NSObject, ARPlugin, ARSessionDelegate {

    private let scene: Scene3D?
    private let camera: Entity?
    private let events: AREvents
    private let gl: GL

    private var session: ARSession?
    /// What the session runs: `setImages` runs it again with another image set.
    private var configuration: ARConfiguration?
    private var mode: ARMode = .world
    private var texture: ExternalTexture?
    private var cancelFrame: GL.Cancel?
    /// The start's reply, until the first frame.
    private var starting: Reply<Void, ARCode>?
    /// The newest frame: applied before the next engine frame, read by hitTest / captureFrame.
    private var latest: ARFrame?
    private var applied: TimeInterval = -1
    /// What the background shows through: set again when the viewport turns.
    private var shownUV: [Float] = []

    private var tracking: (TrackingState, TrackingReason?)?
    /// Pose anchors are lost while ARKit relocalizes and regained after.
    private var relocalizing = false
    /// Image targets by their reference image's name (the entity id), and what was last said of each.
    private var images: [String: Entity] = [:]
    /// Each target's reference image, by its entity id: kept across `setImages`, since ARKit knows a
    /// reference image by the object — a new one for the same picture is a new image, found again.
    private var references: [UInt32: ARReferenceImage] = [:]
    private struct ImageSent { var tracked: Bool; var extent: simd_float2; var at: TimeInterval }
    private var imagesSent: [UInt32: ImageSent] = [:]
    /// The anchors `anchor()` made, both ways.
    private var pinned: [UUID: Entity] = [:]
    private var anchorOf: [UInt32: ARAnchor] = [:]

    private struct PlaneSent { let id: Double; var type: PlaneType; var pose: Pose; var center: simd_float3; var extent: simd_float2; var at: TimeInterval }
    private var planes: [UUID: PlaneSent] = [:]
    private var nextPlane = 1.0
    private var lightAt: TimeInterval = 0

    private static let near: Float = 0.01
    private static let far: Float = 1000
    private static let jpeg = CIContext()

    init(_ params: ARParams, _ events: AREvents, _ gl: GL) {
        self.scene = params.scene
        self.camera = params.camera
        self.events = events
        self.gl = gl
        super.init()
    }

    // MARK: - the calls

    func start(_ options: StartOptions?, _ reply: Reply<Void, ARCode>) {
        guard session == nil else { return reply.reject(.busy) }
        guard scene != nil, camera != nil else {
            print("[ar] start: the session has no scene or camera to drive (ARScene opens it with both)")
            return reply.reject(.failed)
        }
        let mode = options?.mode ?? .world
        let supported = mode == .images ? ARImageTrackingConfiguration.isSupported : ARWorldTrackingConfiguration.isSupported
        guard supported else {
            print("[ar] ARKit \(mode == .images ? "image" : "world") tracking is not supported on this device")
            return reply.reject(.unavailable)
        }
        guard let texture = gl.createExternalTexture() else {
            print("[ar] this host has no 3D engine: there is nothing to draw the camera into")
            return reply.reject(.unavailable)
        }

        let targets = referenceImages(options?.images ?? [])
        if !(options?.codes ?? []).isEmpty { print("[ar] QR targets are not tracked on this platform yet") }
        let configuration: ARConfiguration
        if mode == .images {
            let c = ARImageTrackingConfiguration()
            c.isAutoFocusEnabled = options?.autoFocus ?? true
            configuration = c
        } else {
            let c = ARWorldTrackingConfiguration()
            c.planeDetection = Self.detection(options?.planes ?? .horizontal)
            c.automaticImageScaleEstimationEnabled = true
            c.environmentTexturing = .none
            c.isAutoFocusEnabled = options?.autoFocus ?? true
            c.worldAlignment = Self.alignment(options?.worldAlignment ?? .gravity)
            configuration = c
        }
        configuration.isLightEstimationEnabled = options?.lightEstimation ?? false
        Self.use(targets, in: configuration)

        let session = ARSession()
        session.delegate = self
        session.delegateQueue = .main   // the engine's thread
        self.session = session
        self.configuration = configuration
        self.mode = mode
        self.texture = texture
        starting = reply
        cancelFrame = gl.onFrame { [weak self] in self?.frame() }
        session.run(configuration)
    }

    func stop(_ reply: Reply<Void, ARCode>) {
        end()
        reply.resolve()
    }

    func setImages(_ targets: [ImageTarget], _ reply: Reply<Void, ARCode>) {
        guard let session, let configuration else { return reply.reject(.notRunning) }
        let before = images
        let set = referenceImages(targets)
        // an image that left the set no longer drives its entity (`follow` reads `images`) and, tracked,
        // says so once; its anchor is removed from the session — ARKit is not said to drop the anchor
        // of a reference no longer configured, and a later target of that name would find it there
        var gone = Set<String>()
        for (name, entity) in before where images[name] == nil {
            gone.insert(name)
            if let sent = imagesSent.removeValue(forKey: entity.id), sent.tracked {
                events.image(entity: entity, tracked: false, extent: [Double(sent.extent.x), Double(sent.extent.y)])
            }
        }
        for case let anchor as ARImageAnchor in session.currentFrame?.anchors ?? [] {
            if let name = anchor.referenceImage.name, gone.contains(name) { session.remove(anchor: anchor) }
        }
        Self.use(set, in: configuration)
        // no reset options: the tracking, the planes and the anchors stay
        session.run(configuration)
        reply.resolve()
    }

    // QR targets (contract version 2) are the web's first: this half tracks none yet
    func setCodes(_ codes: [QRTarget], _ reply: Reply<Void, ARCode>) {
        guard session != nil else { return reply.reject(.notRunning) }
        print("[ar] QR targets are not tracked on this platform yet")
        reply.reject(.failed)
    }

    func hitTest(_ x: Double, _ y: Double, _ target: HitTarget?, _ reply: Reply<[HitResult], ARCode>) {
        guard let session, let frame = latest, let scene else { return reply.reject(.notRunning) }
        guard mode == .world else { return reply.resolve([]) }
        let view = gl.viewport(scene)
        guard view.width > 0, view.height > 0 else { return reply.resolve([]) }
        // the point in the scene view (its touches' space) → the captured image's normalized
        // coordinates (what a raycast query takes)
        let point = CGPoint(x: x / Double(view.width), y: y / Double(view.height))
            .applying(frame.displayTransform(for: Self.orientation(view.rotation), viewportSize: CGSize(width: view.width, height: view.height)).inverted())
        let targets: [ARRaycastQuery.Target]
        switch target ?? .any {
        case .planes: targets = [.existingPlaneGeometry]
        case .estimated: targets = [.estimatedPlane]
        case .any: targets = [.existingPlaneGeometry, .estimatedPlane]
        }
        let eye = Self.position(frame.camera.transform)
        var hits: [HitResult] = []
        for t in targets {
            for r in session.raycast(frame.raycastQuery(from: point, allowing: t, alignment: .any)) {
                let onPlane = t == .existingPlaneGeometry ? r.anchor.flatMap { planes[$0.identifier]?.id } : nil
                hits.append(HitResult(pose: Self.pose(r.worldTransform), type: onPlane == nil ? .estimated : .plane,
                                      plane: onPlane, distance: Double(simd_distance(Self.position(r.worldTransform), eye))))
            }
        }
        reply.resolve(hits.sorted { $0.distance < $1.distance })
    }

    func anchor(_ entity: Entity, _ pose: Pose, _ reply: Reply<Void, ARCode>) {
        guard let session else { return reply.reject(.notRunning) }
        if let old = anchorOf.removeValue(forKey: entity.id) {
            pinned[old.identifier] = nil
            session.remove(anchor: old)
        }
        let anchor = ARAnchor(name: "lecodes-\(entity.id)", transform: Self.matrix(pose))
        pinned[anchor.identifier] = entity
        anchorOf[entity.id] = anchor
        session.add(anchor: anchor)
        gl.setMatrix(entity, anchor.transform)
        reply.resolve()
    }

    func release(_ entity: Entity, _ reply: Reply<Void, ARCode>) {
        if let anchor = anchorOf.removeValue(forKey: entity.id) {
            pinned[anchor.identifier] = nil
            session?.remove(anchor: anchor)
        }
        reply.resolve()
    }

    func captureFrame(_ reply: Reply<PluginFile, ARCode>) {
        guard let frame = latest else { return reply.reject(.notRunning) }
        // the image as the user holds the phone (the sensor's is landscape), encoded off the main thread
        let turn = scene.map { gl.viewport($0).rotation } ?? 0
        let image = CIImage(cvPixelBuffer: frame.capturedImage).oriented(Self.upright(Self.orientation(turn)))
        DispatchQueue.global(qos: .userInitiated).async {
            guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                  let data = Self.jpeg.jpegRepresentation(of: image, colorSpace: space, options: [:]) else {
                return reply.reject(.failed)
            }
            reply.resolve(PluginFile(data: data, name: "frame.jpg"))
        }
    }

    func close() { end() }

    // MARK: - each frame (gl.onFrame: before the runtime's tick, so what is written is this frame's)

    private func frame() {
        guard let frame = latest, frame.timestamp != applied, let scene, let texture else { return }
        let view = gl.viewport(scene)
        guard view.width > 0, view.height > 0 else { return }   // not presented yet: the frame after carries the size
        applied = frame.timestamp
        let orientation = Self.orientation(view.rotation)
        let size = CGSize(width: view.width, height: view.height)
        texture.update(frame.capturedImage)
        let uv = Self.uv(frame.displayTransform(for: orientation, viewportSize: size))
        if uv != shownUV {
            shownUV = uv
            gl.setBackground(scene, texture, uv: uv)
        }
        gl.setCameraMatrix(scene, frame.camera.viewMatrix(for: orientation).inverse)
        gl.setProjection(scene, frame.camera.projectionMatrix(for: orientation, viewportSize: size, zNear: CGFloat(Self.near), zFar: CGFloat(Self.far)),
                         near: Self.near, far: Self.far)
        for anchor in frame.anchors {
            if let image = anchor as? ARImageAnchor {
                follow(image, at: frame.timestamp)
            } else if let entity = pinned[anchor.identifier] {
                gl.setMatrix(entity, anchor.transform)
            }
        }
        if let estimate = frame.lightEstimate, frame.timestamp - lightAt >= 0.1 {
            lightAt = frame.timestamp
            events.light(intensity: Double(estimate.ambientIntensity), temperature: Double(estimate.ambientColorTemperature))
        }
    }

    /// An image target: while tracked its entity is on the image — a rigid pose, its centre, Y out of
    /// it, no scale — and its size is the reference's as ARKit estimates it (`estimatedScaleFactor`).
    private func follow(_ image: ARImageAnchor, at time: TimeInterval) {
        guard let name = image.referenceImage.name, let entity = images[name] else { return }
        if image.isTracked { gl.setMatrix(entity, image.transform) }
        let size = image.referenceImage.physicalSize, k = image.estimatedScaleFactor
        imageChanged(entity, tracked: image.isTracked, extent: simd_float2(Float(size.width * k), Float(size.height * k)), at: time)
    }

    /// Said when it is found or lost, and while tracked when its size moved by a millimetre since it
    /// was last said and a tenth of a second has passed; never for an image not yet seen.
    private func imageChanged(_ entity: Entity, tracked: Bool, extent: simd_float2?, at time: TimeInterval) {
        let sent = imagesSent[entity.id]
        let size = extent ?? sent?.extent ?? .zero
        if let sent, sent.tracked == tracked {
            guard tracked, simd_distance(sent.extent, size) >= 0.001, time - sent.at >= 0.1 else { return }
        } else if sent == nil, !tracked {
            return
        }
        imagesSent[entity.id] = ImageSent(tracked: tracked, extent: size, at: time)
        events.image(entity: entity, tracked: tracked, extent: [Double(size.x), Double(size.y)])
    }

    // MARK: - ARSessionDelegate (the main queue)

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard session === self.session else { return }
        latest = frame
        guard let starting else { return }
        // the first frame: tracking is the session's first event, then the start resolves
        self.starting = nil
        report(frame.camera.trackingState)
        starting.resolve()
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        guard session === self.session, starting == nil else { return }
        report(camera.trackingState)
    }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        guard session === self.session else { return }
        for case let plane as ARPlaneAnchor in anchors { planeChanged(plane, at: session.currentFrame?.timestamp ?? 0) }
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        guard session === self.session else { return }
        for case let plane as ARPlaneAnchor in anchors { planeChanged(plane, at: session.currentFrame?.timestamp ?? 0) }
    }

    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        guard session === self.session else { return }
        for anchor in anchors {
            if let plane = anchor as? ARPlaneAnchor, let sent = planes.removeValue(forKey: plane.identifier) {
                events.plane(change: .removed, id: sent.id, type: sent.type, pose: sent.pose, extent: [Double(sent.extent.x), Double(sent.extent.y)], polygon: [])
            } else if let image = anchor as? ARImageAnchor, let name = image.referenceImage.name, let entity = images[name] {
                imageChanged(entity, tracked: false, extent: nil, at: session.currentFrame?.timestamp ?? 0)
            } else if let entity = pinned.removeValue(forKey: anchor.identifier) {
                // ARKit dropped an anchor of ours (a world map that no longer holds it): lost for good
                anchorOf[entity.id] = nil
                events.anchor(entity: entity, tracked: false)
            }
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        guard session === self.session else { return }
        let code: ARErrorCode
        switch (error as? ARError)?.code {
        case .unsupportedConfiguration?: code = .unavailable
        case .cameraUnauthorized?, .sensorUnavailable?, .sensorFailed?: code = .camera
        default: code = .failed
        }
        print("[ar] the session failed: \(error.localizedDescription)")
        if let starting {
            self.starting = nil
            end()
            starting.reject(code == .unavailable ? .unavailable : .failed)
        } else {
            end()
            events.error(code: code, message: error.localizedDescription)
        }
    }

    // MARK: - events

    private func report(_ state: ARCamera.TrackingState) {
        let now: (TrackingState, TrackingReason?)
        switch state {
        case .notAvailable: now = (.notAvailable, nil)
        case .normal: now = (.normal, nil)
        case .limited(let reason):
            switch reason {
            case .initializing: now = (.limited, .initializing)
            case .excessiveMotion: now = (.limited, .excessiveMotion)
            case .insufficientFeatures: now = (.limited, .insufficientFeatures)
            case .relocalizing: now = (.limited, .relocalizing)
            @unknown default: now = (.limited, nil)
            }
        }
        if let tracking, tracking == now { return }
        tracking = now
        events.tracking(state: now.0, reason: now.1)
        // the anchors `anchor()` made are not where they were while ARKit relocalizes
        if now.1 == .relocalizing, !relocalizing {
            relocalizing = true
            for entity in pinned.values { events.anchor(entity: entity, tracked: false) }
        } else if now.0 == .normal, relocalizing {
            relocalizing = false
            for entity in pinned.values { events.anchor(entity: entity, tracked: true) }
        }
    }

    /// A plane added or changed: sent when it is new, or moved / grown by a centimetre since it was
    /// last sent and a tenth of a second has passed.
    private func planeChanged(_ plane: ARPlaneAnchor, at time: TimeInterval) {
        let type: PlaneType = plane.alignment == .vertical ? .vertical : .horizontal
        // the centre, Y along the normal (and, from iOS 16, turned with the extent about it)
        var turn: Float = 0
        var extent = simd_float2(plane.extent.x, plane.extent.z)
        if #available(iOS 16.0, *) {
            turn = plane.planeExtent.rotationOnYAxis
            extent = simd_float2(plane.planeExtent.width, plane.planeExtent.height)
        }
        let local = simd_float4x4(translation: plane.center) * simd_float4x4(simd_quatf(angle: turn, axis: simd_float3(0, 1, 0)))
        let world = plane.transform * local
        let center = Self.position(world)
        let sent = planes[plane.identifier]
        if let sent {
            let moved = simd_distance(sent.center, center) >= 0.01 || simd_distance(sent.extent, extent) >= 0.01
            guard moved, time - sent.at >= 0.1 else { return }
        }
        let inverse = local.inverse
        var polygon: [Double] = []
        polygon.reserveCapacity(plane.geometry.boundaryVertices.count * 2)
        for v in plane.geometry.boundaryVertices {
            let p = inverse * simd_float4(v, 1)
            polygon.append(Double(p.x))
            polygon.append(Double(p.z))
        }
        let pose = Self.pose(world)
        let id = sent?.id ?? nextPlane
        if sent == nil { nextPlane += 1 }
        planes[plane.identifier] = PlaneSent(id: id, type: type, pose: pose, center: center, extent: extent, at: time)
        events.plane(change: sent == nil ? .added : .updated, id: id, type: type, pose: pose,
                     extent: [Double(extent.x), Double(extent.y)], polygon: polygon)
    }

    // MARK: - plumbing

    /// Over: the camera let go, the scene back to its own projection and no background.
    private func end() {
        cancelFrame?()
        cancelFrame = nil
        session?.delegate = nil
        session?.pause()
        session = nil
        if let starting {
            self.starting = nil
            starting.reject(.failed)
        }
        if let scene {
            gl.setBackground(scene, nil)
            gl.clearProjection(scene)
        }
        texture?.close()
        texture = nil
        latest = nil
        applied = -1
        shownUV = []
        tracking = nil
        relocalizing = false
        images.removeAll()
        imagesSent.removeAll()
        pinned.removeAll()
        anchorOf.removeAll()
        planes.removeAll()
        references.removeAll()
        configuration = nil
    }

    /// The targets as ARKit's reference images, `images` and `references` made over for them: a target
    /// already known keeps its reference (ARKit goes on tracking it), a new one is decoded — one that
    /// does not decode is left out (a console line).
    private func referenceImages(_ targets: [ImageTarget]) -> Set<ARReferenceImage> {
        var set = Set<ARReferenceImage>()
        var kept: [UInt32: ARReferenceImage] = [:]
        images.removeAll()
        for target in targets {
            let id = target.entity.id
            let reference: ARReferenceImage
            if let known = references[id], known.physicalSize.width == CGFloat(target.physicalWidth) {
                reference = known
            } else {
                guard let image = UIImage(data: target.image.data)?.cgImage else {
                    print("[ar] an image target did not decode — left out")
                    continue
                }
                reference = ARReferenceImage(image, orientation: .up, physicalWidth: CGFloat(target.physicalWidth))
                reference.name = String(id)
            }
            set.insert(reference)
            kept[id] = reference
            images[String(id)] = target.entity
        }
        references = kept
        return set
    }

    /// The image set into the configuration, as world tracking detects them or image tracking tracks them.
    private static func use(_ set: Set<ARReferenceImage>, in configuration: ARConfiguration) {
        if let c = configuration as? ARImageTrackingConfiguration {
            c.trackingImages = set
            c.maximumNumberOfTrackedImages = max(1, set.count)
        } else if let c = configuration as? ARWorldTrackingConfiguration {
            c.detectionImages = set
            c.maximumNumberOfTrackedImages = set.count
        }
    }

    private static func detection(_ planes: PlaneDetection) -> ARWorldTrackingConfiguration.PlaneDetection {
        switch planes {
        case .horizontal: return .horizontal
        case .vertical: return .vertical
        case .both: return [.horizontal, .vertical]
        case .none: return []
        }
    }

    /// Heading alignment needs the compass, which ARKit reads only with location access: without
    /// it, gravity alone (and a line saying so).
    private static func alignment(_ alignment: WorldAlignment) -> ARConfiguration.WorldAlignment {
        guard alignment == .gravityAndHeading else { return .gravity }
        switch CLLocationManager().authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: return .gravityAndHeading
        default:
            print("[ar] worldAlignment \"gravityAndHeading\" needs location access — aligned by gravity only")
            return .gravity
        }
    }

    /// The viewport's turn (degrees, the display from its natural portrait) as the interface
    /// orientation ARKit's display calls take.
    private static func orientation(_ rotation: Int) -> UIInterfaceOrientation {
        switch rotation {
        case 90: return .landscapeRight
        case 180: return .portraitUpsideDown
        case 270: return .landscapeLeft
        default: return .portrait
        }
    }

    /// The camera image is landscape-right native: how it is turned to stand as the interface does.
    private static func upright(_ orientation: UIInterfaceOrientation) -> CGImagePropertyOrientation {
        switch orientation {
        case .portrait: return .right
        case .portraitUpsideDown: return .left
        case .landscapeLeft: return .down
        default: return .up
        }
    }

    /// `displayTransform` maps the image's normalized point to the view's; the background wants the
    /// other way, as the rows [a b tx; c d ty] of u = a·x + b·y + tx, v = c·x + d·y + ty.
    private static func uv(_ display: CGAffineTransform) -> [Float] {
        let t = display.inverted()
        return [Float(t.a), Float(t.c), Float(t.tx), Float(t.b), Float(t.d), Float(t.ty)]
    }

    private static func position(_ m: simd_float4x4) -> simd_float3 { simd_float3(m.columns.3.x, m.columns.3.y, m.columns.3.z) }

    private static func pose(_ m: simd_float4x4) -> Pose {
        let p = position(m)
        let q = simd_quatf(simd_float3x3(simd_normalize(simd_float3(m.columns.0.x, m.columns.0.y, m.columns.0.z)),
                                         simd_normalize(simd_float3(m.columns.1.x, m.columns.1.y, m.columns.1.z)),
                                         simd_normalize(simd_float3(m.columns.2.x, m.columns.2.y, m.columns.2.z))))
        return Pose(position: Vec3(x: Double(p.x), y: Double(p.y), z: Double(p.z)),
                    rotation: Quat(x: Double(q.imag.x), y: Double(q.imag.y), z: Double(q.imag.z), w: Double(q.real)))
    }

    private static func matrix(_ pose: Pose) -> simd_float4x4 {
        let r = pose.rotation, p = pose.position
        var m = simd_float4x4(simd_quatf(ix: Float(r.x), iy: Float(r.y), iz: Float(r.z), r: Float(r.w)).normalized)
        m.columns.3 = simd_float4(Float(p.x), Float(p.y), Float(p.z), 1)
        return m
    }
}

private extension simd_float4x4 {
    init(translation t: simd_float3) {
        self = matrix_identity_float4x4
        columns.3 = simd_float4(t, 1)
    }
}
