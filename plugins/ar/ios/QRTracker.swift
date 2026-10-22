//
//  QRTracker.swift — lecodes-plugins/ar
//
//  The QR targets of one ARKit session (`StartOptions.codes` / `setCodes`; ARKitSession drives this):
//  a printed QR code of known text and size, found in the camera's picture and kept in the room by
//  an anchor of the session. The port of web/qrAnchor.ts (its header is the spec); what differs
//  natively is said here.
//
//  Who knows what. The camera's pose is ARKit's (`frame.camera.transform`: the SENSOR camera in the
//  world, landscape-right, GL axes — the picture is the sensor's, never the display's). The detector
//  — qr-anchor's C ABI, the binary target QrAnchorFFI (../binaries/README.md names the commit that
//  built it) — knows nothing of the room: from the luma plane of `frame.capturedImage` and the
//  camera's intrinsics (`frame.camera.intrinsics`, for `imageResolution`, handed AS ARKit reports
//  them: the call moves them to its pixel centres and scales them by the factor itself) it finds the
//  symbol and its pose in the camera, `matrix_gl` (the marker's frame in the GL camera: the symbol's
//  centre, X along its top edge, Y out of it, Z towards its bottom, metres — the contract's frame of
//  a code's entity). So
//
//    M = camera.transform × matrix_gl     (column-major; the camera of the frame the plane is of)
//
//  is the code in the session's world. M places the entity at once, and an ARAnchor made at M
//  (`lecodes-qr-<entity id>`, `session.add`: synchronous — no wait for the anchor as on the web)
//  holds it from then on; ARKit keeps it true as its map of the room improves.
//
//  The picture. A COPY of plane 0 of `capturedImage` (YpCbCr 4:2:0 bi-planar: plane 0 = the grey
//  picture, at its bytesPerRow), taken in the frame hook with that frame's camera pose and intrinsics
//  — the ARFrame is never kept past the hook (ARKit starves the camera when frames are retained) —
//  and handed to the detector on a serial queue of its own (a handle is not thread-safe: every qra_*
//  call is made there). The result comes back to the main queue and is applied at the start of the
//  NEXT frame hook; never two pictures out at once. The detector downsamples the plane itself
//  (`qra_process_plane`, a box filter): the 1920-wide plane is 480 wide at factor 4 (the web's
//  SEEK_WIDTH) and 960 at factor 2 (HOLD_WIDTH), the hold windows decoded on the full plane
//  (`full_res`); a narrower plane keeps the factor that leaves it 400 px wide or more.
//
//  The cadence (per frame hook, a frame with a pose — ARKit's tracking not unavailable nor
//  relocalizing: the pose an anchor is made in must be the session's):
//    - SEEKING (a code with no anchor): a factor-4 picture every 2nd frame, the seeking handle
//      (`search_first: false`: a full detection of every picture);
//    - HOLDING (every code's anchor stands): a factor-2 picture every 15th frame at most, and only
//      when a held code's centre projects into the picture (through the intrinsics of this frame,
//      5 % in from its edges) and the camera moves slowly (under 2 cm and 2° since the last frame);
//      the holding handle (the window first) gets each held code's window: its anchor's four corners
//      projected into the picture (× HINT_MARGIN of its side around them), the last observation's
//      corners rescaled when they do not project. The observation against the anchor
//      (`replaceVerdict`, sides in px of the HOLDING picture — both phases compared at one scale): one
//      off by more than 3 cm or 5° (a real move, or a wrong first fix — at 24 points or more and seen
//      at least 0.8 × bestSide), or off by more than 1 cm or 1° and seen at least 0.8 × as large as the
//      largest look at the code since its anchor was made (`bestSide`), REPLACES the anchor: a new one
//      at the observed pose, the old removed, the entity gliding from where it was shown to the new
//      one over SLEW_FRAMES frames (the position along the line, the turn along the arc). One off but
//      seen smaller is KEPT out; one of fewer than 16 points is ignored (a flipped tilt of a small
//      planar marker). A held code missed by 6 holding pictures in a row is sought again (factor 4,
//      full passes), its anchor kept.
//  Each frame a held code's entity is its anchor's transform (`frame.anchors`, by identifier; the
//  anchor's own transform until ARKit has put it in a frame; the glide while one runs). ARKit
//  removing a code's anchor (`didRemove`, or the anchor gone from the frames) = the code lost:
//  `image { tracked: false }` once, the code sought again. `extent` = [size, size].
//
//  "images" mode (ARImageTrackingConfiguration: no world tracking): no anchors — the entity is put
//  at M at each accepted observation and stays (the web's "no anchors" path, seeking pictures
//  only); `tracked: true` at the first, `false` after 6 seeking pictures in a row without it.
//
//  The web's depth scale (web/depthScale.ts) is not ported: it compensates intrinsics derived from
//  a projection matrix, ARKit's are the camera's own. `t` and the rms are in the log, so a bias
//  would show on the phone.
//
//  The detector is made with the first code (two handles: seeking and holding) and freed at `clear`
//  (on its queue, after a picture still out). It failing (a handle not made, an output layout this
//  half does not read, a call's -1) is said once, and no QR codes are tracked for the session.
//
//  The device log (print, `[ar] qr …`; the web's lines but the depth scale, `worker` → `detector`):
//  an accepted observation `[ar] qr <text>: side … px of <width>, rms … px, inliers …, t=(x y z) m,
//  the result after … frames, detector … ms` (t = the code's centre in the camera as solved, GL
//  axes: x right, y up, −z ahead; at most 2 lines a second per code), a replacement's delta (mm, °),
//  an observation kept out or ignored (at most once in 2 s), a find and a loss, the plane's first
//  picture and intrinsics, every 5 s while seeking or holding how many pictures found what, the
//  main thread's copy, the latency in frames and the detector's mean time.
//

import ARKit
import CoreVideo
import Foundation
import LeCodes
import QrAnchorFFI
import QuartzCore
import simd

final class QRTracker {

    // MARK: - the constants (web/qrAnchor.ts's)

    /// The detector's gates (qr-anchor's `Params`, its README) — the smallest apparent side of a
    /// code's first observation, of one once observed in this session (px of the picture), the
    /// largest RMS reprojection error of the inliers — and `search_first` by phase. The holding
    /// handle: the window first; when it misses, the half-resolution search only (never a full pass
    /// of a holding picture — a code missed MISSES_TO_SEEK times is sought by the seeking handle).
    private static let gates = #""min_init_side_px":40,"min_reacquire_side_px":20,"max_rms_px":0.6"#
    private static let seekingConfig = "{\(gates),\"search_first\":false}"
    private static let holdingConfig = "{\(gates),\"search_first\":true,\"full_detect_interval\":1000000}"
    /// The gates' max_rms_px, for `replaceVerdict`.
    static let maxRms = 0.6
    /// The downsampling of a picture: seeking, holding (of a 1920-wide plane: 480 and 960 px).
    private static let seekFactor = 4
    private static let holdFactor = 2
    /// … no smaller than this wide (px): a narrower plane takes a smaller factor.
    private static let minPictureWidth = 400
    /// Holding pictures without the code, in a row, after which it is sought again.
    private static let missesToSeek = 6
    /// Points of an observation, at least: fewer = the pose's tilt may be the flipped one of a small
    /// planar marker (9 points gave a 75° flip on the phone).
    private static let minInliers = 16.0
    /// … for a "move" (a large Δ) to replace the anchor: a flip must not pass as a move.
    static let moveInliers = 24.0
    /// Frames between pictures: seeking, holding.
    private static let seekEvery = 2
    private static let holdEvery = 15
    /// The camera "moves slowly" between two frames: under these.
    private static let slowMetres = 0.02
    private static let slowDegrees = 2.0
    /// A held code's centre is "in the picture": this far in from its edges (a fraction of its size).
    private static let insideMargin = 0.05
    /// An observation this far off its anchor's pose replaces the anchor, when seen large enough.
    static let replaceMetres = 0.01
    static let replaceDegrees = 1.0
    /// … and this far off, whatever its side.
    static let moveMetres = 0.03
    static let moveDegrees = 5.0
    /// "Large enough": at least this × the code's largest side since its anchor was made.
    static let sideRatio = 0.8
    /// Frames a replaced anchor's entity glides over.
    private static let slewFrames = 10
    /// The window around a held code's corners, × its side.
    private static let hintMargin = 0.5
    /// The observation log: at most one line in this per code (ms).
    private static let logPeriod = 500.0
    /// An observation kept out (or ignored) is said at most once in this, per code (ms).
    private static let keptLogPeriod = 2000.0
    /// The seeking / holding summary's period, ms.
    private static let summaryPeriod = 5000.0
    /// The output this half reads (qr-anchor's layout 1): 28 f64 per observation.
    private static let layout: UInt32 = 1
    private static let stride = 28

    /// What an observation of a held code does to its anchor (`metres` / `degrees` off its pose, its
    /// apparent side and `bestSide` in px of a holding picture, its rms in px):
    /// - bad: over the rms gate — ignored;
    /// - move: more than 3 cm or 5° off (a real move, or a wrong first fix) — it replaces the anchor;
    /// - replace: more than 1 cm or 1° off and seen at least 0.8 × bestSide — it replaces the anchor;
    /// - kept: more than 1 cm or 1° off and seen smaller — the anchor stays (a small picture's tilt is
    ///   noise); a large Δ at fewer than 24 points or seen smaller is kept too (a flipped tilt);
    /// - near: within 1 cm and 1° — the anchor stands.
    enum Verdict { case bad, move, replace, kept, near }

    static func replaceVerdict(metres: Double, degrees: Double, side: Double, rms: Double, inliers: Double?,
                               bestSide: Double, maxRms: Double = QRTracker.maxRms) -> Verdict {
        if !(rms <= maxRms) { return .bad }
        if metres > moveMetres || degrees > moveDegrees {
            // a large Δ at few points or a small side is a flipped tilt, not a move
            if let inliers, inliers < moveInliers || side < sideRatio * bestSide { return .kept }
            return .move
        }
        if metres <= replaceMetres && degrees <= replaceDegrees { return .near }
        return side >= sideRatio * bestSide ? .replace : .kept
    }

    // MARK: - the state

    private enum Phase: String { case seeking, holding }

    private final class Code {
        let target: QRTarget
        /// The anchor that drives the entity (world mode), whether ARKit has put it in a frame yet,
        /// and its pose in the last frame (the pose it was made at before that).
        var anchor: ARAnchor?
        var anchorSeen = false
        var anchorPose: QRPose?
        /// The pose the entity was last given.
        var shown: QRPose?
        /// What the `image` event said last.
        var tracked = false
        /// A replacement's glide: from where it was shown, frames so far.
        var slew: (from: QRPose, frame: Int)?
        /// The last observation's corners (TL TR BR BL, x y px) in a picture of `cornersIn`: the window
        /// when the anchor's corners do not project.
        var corners: [Double]?
        var cornersIn = (width: 0, height: 0)
        /// The last observation's side, px of its picture.
        var side = 0.0
        /// Holding pictures without this code, in a row (images mode: seeking ones, once it is tracked).
        var misses = 0
        /// The largest side of the observations since the anchor was made (px of a holding picture).
        var bestSide = 0.0
        var loggedAt = -Double.infinity
        var keptLoggedAt = -Double.infinity

        init(_ target: QRTarget) { self.target = target }
    }

    /// A detection window for one target, px of the downsampled picture (ends exclusive).
    private struct Hint { let target: UInt32; let x0: Int32, y0: Int32, x1: Int32, y1: Int32 }

    /// A picture out: its plane (the detector's buffer: width × height px at `rowBytes`), the camera
    /// it was taken by, its factor, the frame it was taken in. `stale` once the codes changed
    /// meanwhile (its observations name the old list).
    private struct Picture {
        let seq: Int
        let phase: Phase
        let camera: simd_double4x4
        let intrinsics: QRIntrinsics
        let width: Int, height: Int, rowBytes: Int
        let factor: Int
        /// The holding factor of this plane: sides compared in px of a holding picture.
        let holdFactor: Int
        let hints: [Hint]
        let takenAt: Int
        let copyMs: Double
        var stale = false
        var pictureWidth: Int { width / factor }
        var pictureHeight: Int { height / factor }
    }

    /// The detector's word on a picture: its observations (28 f64 each) or why it failed.
    private struct Outcome {
        let generation: Int
        let seq: Int
        let observations: [Double]
        let processMs: Double
        let error: String?
    }

    /// The periodic summary: `phase`'s pictures since `since` (0: not counting).
    private struct Summary {
        var phase: Phase = .seeking
        var since = 0.0
        var pictures = 0, found = 0, resultFrames = 0
        var detectorMs = 0.0, copyMs = 0.0
    }

    private let session: ARSession
    /// World tracking: a found code is held by an anchor. Not in "images" mode.
    private let anchors: Bool
    private let gl: GL
    private let events: AREvents
    private let queue = DispatchQueue(label: "io.letary.lecodes.ar.qr", qos: .userInitiated)

    private var codes: [Code] = []
    /// The codes' anchors by identifier (only the current one of each code).
    private var byAnchor: [UUID: Code] = [:]
    /// Moves at each `clear`: a result or a detector of before is not wanted.
    private var generation = 0
    private var detector: Detector?
    /// The detector's handles are made.
    private var ready = false
    /// This session's detector failed: no other until the session's end.
    private var failed = false
    private var pending: Picture?
    /// The pending picture's outcome, applied at the start of the next frame hook.
    private var arrived: Outcome?
    private var seq = 0
    private var inFlight = false
    /// The frame hooks so far (the latencies are counted in them).
    private var frames = 0
    private var sinceCapture = 0
    private var lastCamera: QRPose?
    /// The plane sizes whose first picture was described (once per session).
    private var described = Set<String>()
    private var summary = Summary()

    init(session: ARSession, anchors: Bool, gl: GL, events: AREvents) {
        self.session = session
        self.anchors = anchors
        self.gl = gl
        self.events = events
    }

    // MARK: - the session's calls

    /// The session's codes (a start's, a setCodes'): the set replaces the one before — a code no
    /// longer listed loses its anchor (`tracked: false` once if it was tracked), a new one seeks. A
    /// code is the same when its entity, text and size are. The first code makes the detector.
    func set(_ set: [QRTarget]) {
        let next = set.map { t in
            codes.first { $0.target.entity == t.entity && $0.target.text == t.text && $0.target.size == t.size } ?? Code(t)
        }
        for c in codes where !next.contains(where: { $0 === c }) { drop(c, tell: true) }
        let changed = next.count != codes.count || zip(next, codes).contains { $0 !== $1 }
        codes = next
        if changed {
            pending?.stale = true
            if let detector, let json = targetsJSON() {
                let mine = generation
                queue.async { [weak self] in
                    guard let why = detector.setTargets(json) else { return }
                    DispatchQueue.main.async { self?.refused(why, generation: mine, detector: detector) }
                }
            }
        }
        ensureDetector()
    }

    /// The session's frame (gl.onFrame, after the camera and the app's anchors): the last picture's
    /// outcome applied, the anchors drive their entities, a picture taken when one is due.
    func frame(_ frame: ARFrame) {
        frames += 1
        if let outcome = arrived {
            arrived = nil
            heard(outcome)
        }
        guard !codes.isEmpty else { return }
        drive(frame)
        let camera = frame.camera
        guard !anchors || Self.posed(camera.trackingState) else { lastCamera = nil; return }
        let slow = slowly(QRPose(camera.transform))
        sinceCapture += 1
        let phases = codes.map(phaseOf)
        // sought: not held, or held and missed by the window for a while (its anchor kept)
        let seeking = codes.indices.contains { phases[$0] == .seeking || codes[$0].misses >= Self.missesToSeek }
        let phase: Phase = seeking ? .seeking : .holding
        let now = Self.now()
        if summary.since == 0 || summary.phase != phase {
            summary = Summary(phase: phase, since: now)
        } else if now - summary.since >= Self.summaryPeriod {
            let s = summary, n = s.pictures
            let again = codes.contains { $0.misses >= Self.missesToSeek } ? ", sought again after \(Self.missesToSeek) misses" : ""
            print("[ar] qr: \(phase.rawValue) — \(n) captures in \(Self.f((now - s.since) / 1000, 0)) s, \(s.found) with a code, the copy \(Self.mean(s.copyMs, n, 2)) ms, the result after \(Self.mean(Double(s.resultFrames), n, 1)) frames, detector \(Self.mean(s.detectorMs, n, 1)) ms mean\(again)")
            summary = Summary(phase: phase, since: now)
        }
        guard !inFlight, ready, let detector else { return }
        let due: Bool
        if seeking {
            due = sinceCapture >= Self.seekEvery
        } else if sinceCapture >= Self.holdEvery, slow {
            let inverse = QRMath.double(camera.transform).inverse
            let k = Self.intrinsics(camera, scale: 1, 1)
            let size = camera.imageResolution
            due = codes.indices.contains { i in
                guard phases[i] == .holding, let at = codes[i].anchorPose else { return false }
                return Self.inside(at.position, inverse, k, Double(size.width), Double(size.height))
            }
        } else {
            due = false
        }
        guard due else { return }
        sinceCapture = 0
        capture(frame, phase, detector)
    }

    /// ARKit removed an anchor (`didRemove`): one of a code = the code lost, sought again.
    func removed(_ anchor: ARAnchor) {
        guard let c = byAnchor[anchor.identifier] else { return }
        lose(c, "lost (ARKit removed its anchor)")
    }

    /// The session's end: every code and anchor gone (no event: the session is over), the detector
    /// freed on its queue (after a picture still out).
    func clear() {
        generation += 1
        for c in codes { drop(c, tell: false) }
        codes = []
        byAnchor.removeAll()
        stopDetector()
        failed = false
        sinceCapture = 0
        lastCamera = nil
        described.removeAll()
        summary = Summary()
    }

    // MARK: - the codes

    private func phaseOf(_ c: Code) -> Phase { c.anchor != nil ? .holding : .seeking }

    private func say(_ c: Code, _ tracked: Bool, _ why: String) {
        guard c.tracked != tracked else { return }
        c.tracked = tracked
        print("[ar] qr \(c.target.text): \(why)")
        events.image(entity: c.target.entity, tracked: tracked, extent: [c.target.size, c.target.size])
    }

    /// A code let go: its anchor removed from the session, said untracked once if it was tracked.
    private func drop(_ c: Code, tell: Bool) {
        if let a = c.anchor {
            byAnchor[a.identifier] = nil
            session.remove(anchor: a)
        }
        c.anchor = nil
        c.anchorSeen = false
        c.anchorPose = nil
        c.slew = nil
        if tell { say(c, false, "no longer a target") }
    }

    /// Its anchor gone (ARKit's doing): the code seeks again.
    private func lose(_ c: Code, _ why: String) {
        if let a = c.anchor { byAnchor[a.identifier] = nil }
        c.anchor = nil
        c.anchorSeen = false
        c.anchorPose = nil
        c.slew = nil
        say(c, false, why)
    }

    /// A new anchor for `c` at `pose` — the one that drives it from now on.
    private func anchor(_ c: Code, at pose: QRPose) {
        let anchor = ARAnchor(name: "lecodes-qr-\(c.target.entity.id)", transform: QRMath.float(pose.matrix))
        c.anchor = anchor
        c.anchorSeen = false
        c.anchorPose = pose
        byAnchor[anchor.identifier] = c
        session.add(anchor: anchor)
    }

    /// The anchors of this frame drive their entities (a glide while one runs).
    private func drive(_ frame: ARFrame) {
        guard !byAnchor.isEmpty else { return }
        var now: [UUID: simd_float4x4] = [:]
        for a in frame.anchors where byAnchor[a.identifier] != nil { now[a.identifier] = a.transform }
        for c in codes {
            guard let anchor = c.anchor else { continue }
            var m: simd_float4x4
            if let t = now[anchor.identifier] {
                m = t
                c.anchorSeen = true
            } else if c.anchorSeen {
                // in a frame before, not in this one: ARKit dropped it (its didRemove comes too)
                lose(c, "lost (ARKit removed its anchor)")
                continue
            } else {
                m = anchor.transform   // added since this frame was made: where it was made
            }
            let at = QRPose(m)
            c.anchorPose = at
            var shown = at
            if var slew = c.slew {
                slew.frame += 1
                shown = QRMath.interpolate(slew.from, at, min(1, Double(slew.frame) / Double(Self.slewFrames)))
                c.slew = slew.frame >= Self.slewFrames ? nil : slew
                m = QRMath.float(shown.matrix)
            }
            c.shown = shown
            gl.setMatrix(c.target.entity, m)
        }
    }

    /// An observation of `c` (the record at `base` of `o`) in picture `p`: M = the picture's camera ×
    /// matrix_gl.
    private func observed(_ c: Code, _ o: [Double], at base: Int, _ p: Picture, _ processMs: Double, _ resultFrames: Int) {
        let side = o[base + 1], rms = o[base + 2], inliers = o[base + 3]
        let now = Self.now()
        let name = c.target.text
        c.misses = 0
        if inliers < Self.minInliers {
            if now - c.keptLoggedAt >= Self.keptLogPeriod {
                c.keptLoggedAt = now
                print("[ar] qr \(name): ignored (\(Self.f(inliers, 0)) points < \(Self.f(Self.minInliers, 0)); side \(Self.f(side, 0)) px of \(p.pictureWidth), rms \(Self.f(rms, 2)) px)")
            }
            return
        }
        let inCamera = QRMath.matrix(o, at: base + 4)
        let m = p.camera * inCamera
        let pose = QRPose(m)
        c.corners = Array(o[(base + 20) ..< (base + 28)])
        c.cornersIn = (p.pictureWidth, p.pictureHeight)
        c.side = side
        /// the side in px of a holding picture: the sides of both phases compared
        let atHold = side * Double(p.factor) / Double(p.holdFactor)
        if now - c.loggedAt >= Self.logPeriod {
            c.loggedAt = now
            let t = inCamera.columns.3
            print("[ar] qr \(name): side \(Self.f(side, 0)) px of \(p.pictureWidth), rms \(Self.f(rms, 2)) px, inliers \(Self.f(inliers, 0)), t=(\(Self.f(t.x, 3)) \(Self.f(t.y, 3)) \(Self.f(t.z, 3))) m, the result after \(resultFrames) frames, detector \(Self.f(processMs, 1)) ms")
        }
        guard phaseOf(c) == .holding, let held = c.anchorPose else {
            // found (or found again, its anchor lost): put there at once, an anchor made there
            c.slew = nil
            c.shown = pose
            c.bestSide = atHold
            gl.setMatrix(c.target.entity, QRMath.float(m))
            let at = pose.position
            say(c, true, "found at (\(Self.f(at.x, 3)) \(Self.f(at.y, 3)) \(Self.f(at.z, 3))) m")
            if anchors { anchor(c, at: pose) }
            return
        }
        // holding: the observation against the anchor
        let dm = QRMath.distance(pose.position, held.position), dd = QRMath.angle(pose.rotation, held.rotation)
        let verdict = Self.replaceVerdict(metres: dm, degrees: dd, side: atHold, rms: rms, inliers: inliers, bestSide: c.bestSide)
        let delta = "Δ \(Self.f(dm * 1000, 1)) mm, \(Self.f(dd, 2))°"
        switch verdict {
        case .near:
            c.bestSide = max(c.bestSide, atHold)
        case .kept:
            if now - c.keptLoggedAt >= Self.keptLogPeriod {
                c.keptLoggedAt = now
                print("[ar] qr \(name): kept (side \(Self.f(atHold, 0)) < \(Self.sideRatio) × \(Self.f(c.bestSide, 0)) px), \(delta) (rms \(Self.f(rms, 2)) px)")
            }
        case .replace, .move:
            print("[ar] qr \(name): anchor replaced\(verdict == .move ? " (a large Δ)" : ""), \(delta) (side \(Self.f(atHold, 0)) px, best \(Self.f(c.bestSide, 0)), rms \(Self.f(rms, 2)) px)")
            c.bestSide = atHold
            // the new anchor at once, the old one removed, the entity gliding from where it is shown
            let old = c.anchor
            anchor(c, at: pose)
            if let old {
                byAnchor[old.identifier] = nil
                session.remove(anchor: old)
            }
            c.slew = c.shown.map { (from: $0, frame: 0) }
        case .bad:
            break
        }
    }

    /// The detector's word on the pending picture (at the start of a frame hook).
    private func heard(_ outcome: Outcome) {
        guard let p = pending, p.seq == outcome.seq else { return }
        pending = nil
        inFlight = false
        if let error = outcome.error {
            lost(error)
            return
        }
        let o = outcome.observations
        let n = o.count / Self.stride
        let resultFrames = frames - p.takenAt
        if summary.since > 0, p.phase == summary.phase {
            summary.pictures += 1
            summary.detectorMs += outcome.processMs
            summary.copyMs += p.copyMs
            summary.resultFrames += resultFrames
            if n > 0 { summary.found += 1 }
        }
        if p.stale { return }
        /// the code a record names (its index in the targets the picture was processed with)
        func index(_ k: Int) -> Int? {
            let i = o[k * Self.stride]
            return i >= 0 && i < Double(codes.count) ? Int(i) : nil
        }
        var seen = Set<Int>()
        for k in 0 ..< n { if let i = index(k) { seen.insert(i) } }
        if p.phase == .holding {
            for (i, c) in codes.enumerated() where !seen.contains(i) && phaseOf(c) == .holding { c.misses += 1 }
        } else if !anchors {
            // no anchors: the pictures say a code is lost
            for (i, c) in codes.enumerated() where !seen.contains(i) && c.tracked {
                c.misses += 1
                if c.misses >= Self.missesToSeek {
                    c.misses = 0
                    say(c, false, "lost (not seen in \(Self.missesToSeek) pictures in a row)")
                }
            }
        }
        for k in 0 ..< n {
            guard let i = index(k) else { continue }
            observed(codes[i], o, at: k * Self.stride, p, outcome.processMs, resultFrames)
        }
    }

    // MARK: - the picture

    /// Plane 0 of the frame's capturedImage copied into the detector's buffer and handed to its queue,
    /// with the windows of the held codes in the downsampled picture's pixels.
    private func capture(_ frame: ARFrame, _ phase: Phase, _ detector: Detector) {
        let t0 = CACurrentMediaTime()
        let buffer = frame.capturedImage
        let format = CVPixelBufferGetPixelFormatType(buffer)
        guard format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange || format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange else {
            lost("the camera's picture is \(Self.fourcc(format)), not 8-bit 4:2:0 bi-planar")
            return
        }
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return }   // this frame's skipped
        let width = CVPixelBufferGetWidthOfPlane(buffer, 0), height = CVPixelBufferGetHeightOfPlane(buffer, 0)
        let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0), width > 0, height > 0, rowBytes >= width else {
            CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
            lost("the camera's plane is \(width)×\(height) at \(rowBytes) bytes a row")
            return
        }
        // the rows at their bytesPerRow, the last one's padding left out
        let bytes = (height - 1) * rowBytes + width
        let plane = detector.reserve(bytes)
        memcpy(plane, base, bytes)
        CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
        let copyMs = (CACurrentMediaTime() - t0) * 1000

        let camera = frame.camera
        let resolution = camera.imageResolution
        let k = Self.intrinsics(camera, scale: Double(width) / Double(resolution.width), Double(height) / Double(resolution.height))
        let factor = Self.factor(width, phase == .seeking ? Self.seekFactor : Self.holdFactor)
        let holdFactor = Self.factor(width, Self.holdFactor)
        let key = "\(width)×\(height)"
        if !described.contains(key) {
            described.insert(key)
            print("[ar] qr: the capture is \(key) luma (plane 0, \(rowBytes) bytes a row; seeking \(width / Self.factor(width, Self.seekFactor)) px / holding \(width / holdFactor) px, the windows at full resolution), fx \(Self.f(k.fx, 1)) fy \(Self.f(k.fy, 1)) cx \(Self.f(k.cx, 1)) cy \(Self.f(k.cy, 1)) px (ARKit's)")
        }
        let cameraPose = QRMath.double(camera.transform)
        let hints = phase == .holding ? self.hints(cameraPose.inverse, k, factor, width / factor, height / factor) : []
        seq += 1
        let picture = Picture(seq: seq, phase: phase, camera: cameraPose, intrinsics: k, width: width, height: height,
                              rowBytes: rowBytes, factor: factor, holdFactor: holdFactor, hints: hints,
                              takenAt: frames, copyMs: copyMs)
        pending = picture
        inFlight = true
        let mine = generation
        queue.async { [weak self] in
            let (observations, ms, error) = detector.process(picture)
            DispatchQueue.main.async {
                guard let self, mine == self.generation, self.pending?.seq == picture.seq else { return }
                self.arrived = Outcome(generation: mine, seq: picture.seq, observations: observations, processMs: ms, error: error)
            }
        }
    }

    /// The windows of the held codes in a picture `width` × `height` px downsampled by `factor`: where
    /// each IS in it — its anchor's corners projected through the picture's camera (the camera moved
    /// since the code was last seen: where it was seen is stale) — or, when they do not project, where
    /// it was last seen.
    private func hints(_ inverseCamera: simd_double4x4, _ k: QRIntrinsics, _ factor: Int, _ width: Int, _ height: Int) -> [Hint] {
        var hints: [Hint] = []
        let w = Double(width), h = Double(height), scale = Double(factor)
        for (i, c) in codes.enumerated() where phaseOf(c) == .holding {
            var x0 = Double.infinity, y0 = Double.infinity, x1 = -Double.infinity, y1 = -Double.infinity
            var side = 0.0
            if let held = c.anchorPose {
                let m = held.matrix, half = c.target.size / 2
                for (ax, az) in [(-half, -half), (half, -half), (half, half), (-half, half)] {
                    // the corner in the world: the anchor's X along the top edge, Z towards the bottom
                    let corner = m * simd_double4(ax, 0, az, 1)
                    guard let px = QRMath.project(simd_double3(corner.x, corner.y, corner.z), inverseCamera, k) else {
                        x0 = .infinity
                        break
                    }
                    // the full plane's px (corners at integers) → the downsampled picture's (centres)
                    let x = px.x / scale - 0.5, y = px.y / scale - 0.5
                    x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
                }
                side = max(x1 - x0, y1 - y0)
            }
            if !(x0 < .infinity), let corners = c.corners, c.cornersIn.width > 0, c.cornersIn.height > 0 {
                let sx = w / Double(c.cornersIn.width), sy = h / Double(c.cornersIn.height)
                x0 = .infinity; y0 = .infinity; x1 = -.infinity; y1 = -.infinity
                for j in 0 ..< 4 {
                    let x = corners[2 * j] * sx, y = corners[2 * j + 1] * sy
                    x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
                }
                side = c.side * max(sx, sy)
            }
            guard x0.isFinite, y0.isFinite, x1.isFinite, y1.isFinite, side.isFinite else { continue }
            let margin = Self.hintMargin * side
            // clamped to the picture (the detector clamps too; an Int32 must not overflow)
            let left = min(max((x0 - margin).rounded(.down), 0), w), top = min(max((y0 - margin).rounded(.down), 0), h)
            let right = min(max((x1 + margin).rounded(.up), 0), w), bottom = min(max((y1 + margin).rounded(.up), 0), h)
            guard right > left, bottom > top else { continue }   // all of it outside the picture
            hints.append(Hint(target: UInt32(i), x0: Int32(left), y0: Int32(top), x1: Int32(right), y1: Int32(bottom)))
        }
        return hints
    }

    /// Is this frame's camera moving slowly (since the last frame)?
    private func slowly(_ camera: QRPose) -> Bool {
        let last = lastCamera
        lastCamera = camera
        guard let last else { return false }
        return QRMath.distance(camera.position, last.position) < Self.slowMetres
            && QRMath.angle(camera.rotation, last.rotation) < Self.slowDegrees
    }

    // MARK: - the detector

    private func targetsJSON() -> String? {
        struct Target: Encodable { let text: String; let size: Double }
        guard let data = try? JSONEncoder().encode(codes.map { Target(text: $0.target.text, size: $0.target.size) }),
              let json = String(data: data, encoding: .utf8) else {
            lost("the targets do not encode as JSON (a size that is not a number?)")
            return nil
        }
        return json
    }

    /// The detector made with the first code: its handles on its queue, `ready` once they are.
    private func ensureDetector() {
        guard detector == nil, !failed, !codes.isEmpty, let json = targetsJSON() else { return }
        let d = Detector()
        detector = d
        let mine = generation
        queue.async { [weak self] in
            let t0 = CACurrentMediaTime()
            let why = d.make(seeking: Self.seekingConfig, holding: Self.holdingConfig, targets: json)
            let ms = (CACurrentMediaTime() - t0) * 1000
            let version = String(cString: qra_version())
            DispatchQueue.main.async {
                guard let self, mine == self.generation, self.detector === d else { return }
                if let why {
                    self.lost(why)
                } else {
                    self.ready = true
                    print("[ar] qr: qr-anchor \(version), its detectors made in \(Self.f(ms, 0)) ms")
                }
            }
        }
    }

    /// The detector's queue said a call failed (for this session's detector, still the one).
    private func refused(_ why: String, generation mine: Int, detector d: Detector) {
        guard mine == generation, detector === d else { return }
        lost(why)
    }

    /// The detector failed: said once, no QR codes this session (the anchors made stay).
    private func lost(_ why: String) {
        guard !failed else { return }
        failed = true
        stopDetector()
        print("[ar] the QR detector failed (\(why)): QR codes are not tracked")
    }

    private func stopDetector() {
        if let d = detector { queue.async { d.free() } }
        detector = nil
        ready = false
        inFlight = false
        pending = nil
        arrived = nil
    }

    /// qr-anchor's two handles (seeking, holding) and the picture's bytes. The handles are used on the
    /// tracker's queue only; the buffer is filled on the main thread while no picture is out and read
    /// on the queue while one is (the dispatch orders the two).
    private final class Detector {
        private var seeking: OpaquePointer?
        private var holding: OpaquePointer?
        /// Room for the observations: targets × 28 f64.
        private var out: [Double] = []
        private var plane: UnsafeMutablePointer<UInt8>?
        private var capacity = 0

        /// Both handles and the targets (on the queue); why not, on a failure.
        func make(seeking seekingConfig: String, holding holdingConfig: String, targets: String) -> String? {
            let layout = qra_output_layout_version(), stride = qra_output_stride()
            guard layout == QRTracker.layout, Int(stride) == QRTracker.stride else {
                return "its output is layout \(layout) × \(stride), this half reads \(QRTracker.layout) × \(QRTracker.stride)"
            }
            seeking = qra_new(seekingConfig)
            holding = qra_new(holdingConfig)
            guard seeking != nil, holding != nil else { return "qra_new refused its config" }
            return setTargets(targets)
        }

        /// Both handles' targets replaced (on the queue); why not, on a failure.
        func setTargets(_ json: String) -> String? {
            var count: Int32 = 0
            for h in [seeking, holding] {
                guard let h else { continue }
                count = qra_set_targets(h, json)
                if count < 0 { return "its targets were refused: \(Self.error(h))" }
            }
            out = [Double](repeating: 0, count: Int(count) * QRTracker.stride)
            return nil
        }

        /// The buffer, `bytes` long at least (on the main thread, no picture out).
        func reserve(_ bytes: Int) -> UnsafeMutablePointer<UInt8> {
            if let plane, capacity >= bytes { return plane }
            plane?.deallocate()
            let made = UnsafeMutablePointer<UInt8>.allocate(capacity: bytes)
            plane = made
            capacity = bytes
            return made
        }

        /// One picture (on the queue): its windows set, the plane processed — the observations, the
        /// detector's ms, why it failed.
        func process(_ p: Picture) -> ([Double], Double, String?) {
            guard let h = p.phase == .seeking ? seeking : holding, let plane else { return ([], 0, "no detector") }
            let t0 = CACurrentMediaTime()
            for hint in p.hints { _ = qra_set_hint(h, hint.target, hint.x0, hint.y0, hint.x1, hint.y1) }
            let k = p.intrinsics
            let n = out.withUnsafeMutableBufferPointer { out in
                qra_process_plane(h, plane, UInt32(p.rowBytes), UInt32(p.width), UInt32(p.height), UInt32(p.factor),
                                  p.phase == .holding ? 1 : 0, k.fx, k.fy, k.cx, k.cy, out.baseAddress, out.count)
            }
            let ms = (CACurrentMediaTime() - t0) * 1000
            if n < 0 { return ([], ms, Self.error(h)) }
            let records = min(Int(n), out.count / QRTracker.stride)
            return (Array(out[0 ..< records * QRTracker.stride]), ms, nil)
        }

        /// The handles and the buffer freed (on the queue, after a picture still out).
        func free() {
            qra_free(seeking)
            qra_free(holding)
            seeking = nil
            holding = nil
            plane?.deallocate()
            plane = nil
            capacity = 0
        }

        private static func error(_ h: OpaquePointer) -> String {
            guard let e = qra_last_error(h) else { return "no reason given" }
            let said = String(cString: e)
            return said.isEmpty ? "no reason given" : said
        }
    }

    // MARK: - plumbing

    /// A pose an anchor may be made in: the session's world (not unavailable, not relocalizing).
    private static func posed(_ state: ARCamera.TrackingState) -> Bool {
        switch state {
        case .notAvailable: return false
        case .limited(.relocalizing): return false
        default: return true
        }
    }

    /// The camera's intrinsics as ARKit reports them (for `imageResolution`: fx = [0][0], fy = [1][1],
    /// cx = [2][0], cy = [2][1]), scaled to a plane of another size.
    private static func intrinsics(_ camera: ARCamera, scale sx: Double, _ sy: Double) -> QRIntrinsics {
        let m = camera.intrinsics
        return QRIntrinsics(fx: Double(m[0][0]) * sx, fy: Double(m[1][1]) * sy, cx: Double(m[2][0]) * sx, cy: Double(m[2][1]) * sy)
    }

    /// Does a point of the world fall into the picture `width` × `height` (px), `insideMargin` in from
    /// its edges, in front of the camera?
    private static func inside(_ point: simd_double3, _ inverseCamera: simd_double4x4, _ k: QRIntrinsics, _ width: Double, _ height: Double) -> Bool {
        guard let px = QRMath.project(point, inverseCamera, k) else { return false }
        let mx = insideMargin * width, my = insideMargin * height
        return px.x >= mx && px.x <= width - mx && px.y >= my && px.y <= height - my
    }

    /// The downsampling of a plane `width` px wide: `wanted`, or less, so the picture stays
    /// `minPictureWidth` wide or more (1, 2 or 4: the detector's).
    private static func factor(_ width: Int, _ wanted: Int) -> Int {
        var f = wanted
        while f > 1 && width / f < minPictureWidth { f /= 2 }
        return f
    }

    private static func now() -> Double { CACurrentMediaTime() * 1000 }

    private static func f(_ x: Double, _ digits: Int) -> String { String(format: "%.\(digits)f", x) }

    private static func mean(_ sum: Double, _ n: Int, _ digits: Int) -> String { f(n > 0 ? sum / Double(n) : 0, digits) }

    private static func fourcc(_ format: OSType) -> String {
        let bytes = [24, 16, 8, 0].map { UInt8((format >> $0) & 0xff) }
        return bytes.allSatisfy({ $0 >= 32 && $0 < 127 }) ? "'\(String(decoding: bytes, as: UTF8.self))'" : "format \(format)"
    }
}
