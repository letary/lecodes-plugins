// ar on the web, the WebXR arm's QR targets (`StartOptions.codes` / `setCodes`, ./webxr.ts drives
// this): a printed QR code of known text and size, found in the camera's picture and kept in the
// room by an anchor of the session.
//
// Who knows what. The camera's pose is ARCore's (the session's `local` space, the viewer's pose of
// each frame). The detector — qr-anchor, a Rust library as wasm (./qr-anchor/, its README names the
// commit that built it), run in a worker (./qrAnchorWorker.ts) — knows nothing of the room: from a
// gray picture of the camera and the picture's intrinsics (the view's projection at the picture's
// size) it finds the symbol and its pose in the camera, `matrix_gl` (the marker's frame in the GL
// camera: the symbol's centre, X along its top edge, Y out of it, Z towards its bottom, metres — the
// contract's frame of a code's entity). So
//
//   M = view.transform.matrix × matrix_gl     (column-major; the view = the camera of that picture)
//
// is the code in the session's space. M places the entity at once, and an XRAnchor made at M (the
// next frame: createAnchor needs one) holds it from then on — ARCore keeps it true as its map of the
// room improves, the picture is not looked at for that.
//
// The cadence (per XR frame with a pose; never two pictures out at once — a picture is out from its
// capture's request to the worker's result). A capture is `captureCamera({ gray: true, maxWidth })`
// of the presentation: the engine reads it back without stalling the frame, so it comes a frame or
// more later, with the projection and the view pose of the frame it was taken in (the pose M uses);
// its bytes are handed to the worker (transferred), the main thread never waits for the detector:
//   - SEEKING (a code with no anchor, or its anchor lost): a 480-wide capture every 2nd frame, the
//     detector's seeking session (`search_first: false`: a full detection of every picture — a small
//     code is missed by the half-resolution search);
//   - HOLDING (every code's anchor stands): a 640-wide capture every 15th frame at most, and only
//     when a held code's centre projects inside the view and the camera moves slowly (under 2 cm and
//     2° since the last frame: a blurred picture gives a worse pose than the anchor has); the
//     detector's holding session (the search first) gets the last observation's corners as its
//     window (set_hint, in this picture's pixels). The observation against the anchor
//     (`replaceVerdict`, sides in px of a 640-wide picture): one off by more than 3 cm or 5° (a real
//     move, or a wrong first fix), or off by more than 1 cm or 1° and seen at least 0.8 × as large
//     as the largest look at the code since its anchor was made (`bestSide`), REPLACES the anchor —
//     a new one at the observed pose; when it is first tracked the old one is deleted and the entity
//     glides from where it was shown to the new anchor over SLEW_FRAMES frames (the position along
//     the line, the turn along the arc), never a jump. One off by more than 1 cm or 1° but seen
//     smaller is KEPT out (a small picture's tilt is noise); any of them over max_rms_px is ignored;
//   - while an anchor is asked for or not yet tracked, the code waits (its observations ignored).
// Each frame an anchor is tracked its pose drives the entity. Not in `frame.trackedAnchors` (once it
// was): `image { tracked: false }` once; tracked again: `tracked: true`. `extent` = [size, size].
//
// The depth scale (./depthScale.ts). The intrinsics the detector derives from the projection can be a
// few percent off the camera picture's own (the first phone run: the square sat ~2 cm closer than the
// code once the camera moved, the fit right where it was taken): every solved translation short by
// one factor. Each code keeps its last 24 observations (rms within max_rms_px, any side, any phase)
// as the camera's pose of the picture and the raw centre in the camera; once the camera positions
// span 4 cm, a least-squares fit of one factor and one point (residual ≤ 8 mm, the factor clamped to
// 0.8 … 1.25) moves the code's scale a quarter of the way to it. Every observation's translation is
// scaled by it (along the camera's ray, the rotation kept) BEFORE the rule above, so the anchor
// follows by its ordinary replacements. 1 until the first estimate; a code's own (a new code starts
// at 1, the session's end drops them all).
//
// The worker is made when the first code is set (the manifest's resource `qrAnchorWorker`,
// `web.resources`, `as: "worker-url"`: the host's bundler builds ./qrAnchorWorker.ts as a module
// worker and the wasm as its asset — nothing of it is fetched before) and ended with the session
// (`clear`). There is no main-thread detector: no worker, no QR codes (said once).
//
// The device log (the dev server's): an accepted observation `[ar] qr <text>: side … px of <width>,
// rms … px, inliers …, t=(x y z) m, the picture after … frames, the result after …, worker … ms`
// (t = the code's centre in the camera as solved, before the depth scale, GL axes: x right, y up,
// −z ahead; at most 2 lines a second), a replacement's delta (mm, °), an observation kept out (at
// most once in 2 s), a loss and a regain, each capture size's first picture and intrinsics, every
// 5 s while seeking or holding how many captures found what, their mean latency in frames, the
// worker's mean time and each code's depth scale; a depth-scale estimate taken that differs by more
// than 0.5 % from the last said (`depth scale <applied> (estimate …, baseline … cm, residual … mm,
// n obs)`), one refused for its residual (at most once in 2 s).

import type { Pose, QRTarget } from "./ar.gen"
import { createDepthScale, DEPTH_SCALE, depthObservation, type DepthScale } from "./depthScale"
import { angle, compose, distance, interpolate, invert, multiply, poseOf, projectToPixels, projectsInside } from "./pose"
import type { FromQRWorker, QRWorkerHint, QRWorkerPhase, QRWorkerTarget, ToQRWorker } from "./qrAnchorWorker"
import type { AnchorWait, CameraGray } from "./webxr"

/** The detector's parameters (qr-anchor's `Params`, its README): the defaults but the gates, and
 *  `search_first` by phase (two detector sessions in the worker: the wasm takes them once). */
const CONFIG = {
  /** the smallest apparent side of a code's first observation (px of the picture) */
  min_init_side_px: 40,
  /** … once it was observed in this session */
  min_reacquire_side_px: 20,
  /** the largest RMS reprojection error of the inliers (the library's default is 1.0) */
  max_rms_px: 0.6,
}
const PHASE_CONFIG: Record<QRWorkerPhase, Record<string, number | boolean>> = {
  seeking: { ...CONFIG, search_first: false },
  // the window first (the anchor projected into the picture); when it misses, the half-resolution
  // search only (cheap, sees a large code) — never a full pass of a HOLD_WIDTH picture: a code missed
  // MISSES_TO_SEEK times in a row is sought again at SEEK_WIDTH, full passes, its anchor kept
  holding: { ...CONFIG, search_first: true, full_detect_interval: 1_000_000 },
}
/** The captures' widths (px): the camera's picture shrunk to it (the aspect kept). */
const SEEK_WIDTH = 480
/** The window pass is cheap whatever the picture's size: a wide picture for the sub-pixel corners of
 *  a small or tilted code (the camera's own width when it is narrower). */
const HOLD_WIDTH = 960
/** Holding captures without the code, in a row, after which it is sought again (480 px, full passes). */
const MISSES_TO_SEEK = 6
/** Points of an observation, at least: fewer = the pose's tilt may be the flipped one of a small
 *  planar marker (9 points gave a 75° flip on the phone). */
const MIN_INLIERS = 16
/** … for a "move" (a large Δ) to replace the anchor: a flip must not pass as a move. */
const MOVE_INLIERS = 24
/** Frames between captures: seeking, holding. */
const SEEK_EVERY = 2
const HOLD_EVERY = 15
/** … while a held code has no depth-scale estimate yet: the estimate wants observations from
 *  several places, soon. */
const HOLD_EVERY_CALIBRATING = 5
/** The camera "moves slowly" between two frames: under these. */
const SLOW_METRES = 0.02
const SLOW_DEGREES = 2
/** An observation this far off its anchor's pose replaces the anchor, when seen large enough. */
const REPLACE_METRES = 0.01
const REPLACE_DEGREES = 1
/** … and this far off, whatever its side. */
const MOVE_METRES = 0.03
const MOVE_DEGREES = 5
/** "Large enough": at least this × the code's largest side since its anchor was made. */
const SIDE_RATIO = 0.8
/** Frames a replaced anchor's entity glides over. */
const SLEW_FRAMES = 10
/** Frames a new anchor may take to be tracked before it is given up. */
const NEW_ANCHOR_FRAMES = 30
/** The window around the last observation's corners, × its side. */
const HINT_MARGIN = 0.5
/** The observation log: at most this many lines a second per code. */
const LOG_PERIOD = 500
/** An observation kept out is said at most once in this, per code (ms). */
const KEPT_LOG_PERIOD = 2000
/** The seeking / holding summary's period, ms. */
const SEEK_LOG_PERIOD = 5000
/** A depth-scale estimate is said when it differs from the last said by more than this (relative). */
const DEPTH_LOG_CHANGE = 0.005
/** The output of qr-anchor (layout 1, the worker checks it): 28 f64 per observation. */
const STRIDE = 28

/** What an observation of a held code does to its anchor (`metres` / `degrees` off its pose, its
 *  apparent side and `bestSide` in px of one picture width, its rms in px):
 *  - "bad": over the rms gate — ignored;
 *  - "move": more than 3 cm or 5° off (a real move, or a wrong first fix) — it replaces the anchor;
 *  - "replace": more than 1 cm or 1° off and seen at least 0.8 × bestSide — it replaces the anchor;
 *  - "kept": more than 1 cm or 1° off and seen smaller — the anchor stays (a small picture's tilt
 *    is noise);
 *  - "near": within 1 cm and 1° — the anchor stands. */
export type ReplaceVerdict = "bad" | "move" | "replace" | "kept" | "near"
export const replaceVerdict = (o: { metres: number, degrees: number, side: number, rms: number, inliers?: number }, bestSide: number, maxRms: number = CONFIG.max_rms_px): ReplaceVerdict => {
  if (!(o.rms <= maxRms)) return "bad"
  if (o.metres > MOVE_METRES || o.degrees > MOVE_DEGREES) {
    // a large Δ at few points or a small side is a flipped tilt, not a move
    if (o.inliers !== undefined && (o.inliers < MOVE_INLIERS || o.side < SIDE_RATIO * bestSide)) return "kept"
    return "move"
  }
  if (o.metres <= REPLACE_METRES && o.degrees <= REPLACE_DEGREES) return "near"
  return o.side >= SIDE_RATIO * bestSide ? "replace" : "kept"
}

/** What the manifest's `web.resources` hands this half (build/plugins.ts of the host). */
export type ARWebResources = { qrAnchorWorker?: string }

/** What the tracker is handed by the arm. */
export type QRTrackerHost = {
  setMatrix(entity: number, m16: ArrayLike<number>): void
  image(payload: { entity: number, tracked: boolean, extent: number[] }): void
  /** The gray picture of this frame (the presentation's captureCamera, resolved a frame or more
   *  later), null when there is none. */
  capture(maxWidth: number): Promise<CameraGray | null>
  /** An anchor at a pose of the session's space, made in the next frame (./webxr.ts's anchorAt). */
  anchor(wait: AnchorWait): void
  /** The session makes anchors ("anchors" granted); without them an entity stays where it was put. */
  anchors(): boolean
  /** The detector worker's URL (the manifest's resource), asked for with the first code. */
  workerUrl(): Promise<string | undefined>
}

type Code = {
  target: QRTarget
  /** The anchor that drives the entity, and how it was in the last frame. */
  anchor: XRAnchor | null
  anchorPose: Pose | null
  anchorTracked: boolean
  /** An anchor asked for (the first, or a replacement) and not made yet. */
  asked: AnchorWait | null
  /** One made and not tracked yet (the one before keeps driving meanwhile), its frames so far. */
  next: XRAnchor | null
  nextFrames: number
  /** The pose the entity was last given. */
  shown: Pose | null
  /** What the `image` event said last. */
  tracked: boolean
  /** A replacement's glide: from where it was shown, frames so far. */
  slew: { from: Pose, frame: number } | null
  /** The last observation's corners (TL TR BR BL, x y px) in a picture of this size: the window. */
  corners: number[] | null
  cornersIn: [number, number]
  /** The last observation's side, px of its picture. */
  side: number
  /** Holding captures without this code, in a row. */
  misses: number
  /** The largest side of the observations taken since the anchor was made (px of a HOLD_WIDTH-wide
   *  picture). */
  bestSide: number
  loggedAt: number
  keptLoggedAt: number
  /** The depth scale (./depthScale.ts): its window and the scale applied to this code's observations. */
  depth: DepthScale
  /** The estimate said last (null: none yet), when a refused one was said last. */
  depthLogged: number | null
  depthRefusedAt: number
}

/** A picture out: asked for in frame `askedAt`, handed to the worker in `capturedAt`; `stale` once
 *  the codes changed meanwhile (its observations name the old list). */
type Pending = { seq: number, phase: QRWorkerPhase, picture: CameraGray, askedAt: number, capturedAt: number, stale: boolean }

const transformPose = (t: XRRigidTransform): Pose => ({
  position: { x: t.position.x, y: t.position.y, z: t.position.z },
  rotation: { x: t.orientation.x, y: t.orientation.y, z: t.orientation.z, w: t.orientation.w },
})

/** The session ended by itself: its anchors are gone with it, none is deleted (a call into an
 *  ended session has crashed Chrome's renderer — webxr.ts's end). */
let sessionGone = false
const deleteAnchor = (anchor: XRAnchor | null) => {
  if (sessionGone) return
  try { anchor?.delete() } catch { /* the session's gone */ }
}

const said = (e: unknown) => e instanceof Error ? e.message : String(e)

/** A module worker of `url`: itself when it is of the page's origin, else a worker of the page
 *  that imports it (a worker's script must be of the page's origin; the halves of the shared Web
 *  Lite are not — the import is a module's, CORS as the half's own). `blob` = the URL to revoke. */
const spawn = (url: string): { worker: Worker, blob: string | null } => {
  const href = new URL(url, location.href)
  if (href.origin === location.origin) return { worker: new Worker(href, { type: "module" }), blob: null }
  const blob = URL.createObjectURL(new Blob([`import ${JSON.stringify(href.href)}\n`], { type: "text/javascript" }))
  try {
    return { worker: new Worker(blob, { type: "module" }), blob }
  } catch (e) {
    URL.revokeObjectURL(blob)
    throw e
  }
}

/** The QR targets of one WebXR arm. */
export const createQRTracker = (host: QRTrackerHost) => {
  let codes: Code[] = []
  /** Moves at each `clear`: a capture, an anchor or a worker of before is not wanted. */
  let generation = 0
  let worker: Worker | null = null
  let blob: string | null = null
  /** The worker said `ready` (its module loaded, its sessions made). */
  let ready = false
  let spawning = false
  /** This session's worker failed (or none could be made): no other until the session's end. */
  let failed = false
  let pending: Pending | null = null
  let seq = 0
  let inFlight = false
  /** The XR frames so far (the latencies are counted in them). */
  let frames = 0
  let sinceCapture = 0
  let lastViewer: Pose | null = null
  /** The capture widths whose first picture was described (once per session). */
  const described = new Set<number>()
  /** The periodic summary: the results of `phase`'s captures since `since` (0: not counting). */
  const summary = { phase: "seeking" as QRWorkerPhase, since: 0, captures: 0, found: 0, workerMs: 0, captureFrames: 0, resultFrames: 0 }
  const restartSummary = (since: number) => {
    summary.since = since
    summary.captures = summary.found = summary.workerMs = summary.captureFrames = summary.resultFrames = 0
  }

  const extent = (c: Code) => [c.target.size, c.target.size]
  const say = (c: Code, tracked: boolean, why: string) => {
    if (c.tracked === tracked) return
    c.tracked = tracked
    console.log(`[ar] qr ${c.target.text}: ${why}`)
    host.image({ entity: c.target.entity, tracked, extent: extent(c) })
  }

  /** The detector's targets: the codes in their order (an observation names its code by it). */
  const targetsOf = (): QRWorkerTarget[] => codes.map((c) => ({ text: c.target.text, size: c.target.size }))
  const post = (message: ToQRWorker, transfer: Transferable[] = []) => worker?.postMessage(message, transfer)

  const revokeBlob = () => {
    if (blob) URL.revokeObjectURL(blob)
    blob = null
  }
  const stopWorker = () => {
    worker?.terminate()
    worker = null
    revokeBlob()
    ready = spawning = inFlight = false
    pending = null
  }
  /** The worker failed: said once, no QR codes this session. */
  const lost = (why: string) => {
    if (failed) return
    failed = true
    stopWorker()
    console.warn(`[ar] the QR detector failed (${why}): QR codes are not tracked`)
  }

  const ensureWorker = () => {
    if (worker || spawning || failed || codes.length === 0) return
    if (typeof Worker === "undefined") { lost("this browser has no workers"); return }
    spawning = true
    const mine = generation
    host.workerUrl().then((url) => {
      if (mine !== generation) return
      spawning = false
      if (!url) throw new Error("the half was built without its worker (the manifest's qrAnchorWorker)")
      const made = spawn(url)
      const w = made.worker
      worker = w
      blob = made.blob
      w.onmessage = (event: MessageEvent<FromQRWorker>) => { if (worker === w) heard(event.data) }
      w.onerror = (event: ErrorEvent) => {
        event.preventDefault()
        if (worker === w) lost(event.message || "its module did not load")
      }
      post({ type: "init", config: PHASE_CONFIG, targets: targetsOf() })
    }).catch((e: unknown) => {
      if (mine === generation) lost(said(e))
    })
  }

  const newCode = (target: QRTarget): Code => ({
    target, anchor: null, anchorPose: null, anchorTracked: false, asked: null, next: null, nextFrames: 0,
    shown: null, tracked: false, slew: null, corners: null, cornersIn: [0, 0], side: 0, misses: 0, bestSide: 0,
    loggedAt: -Infinity, keptLoggedAt: -Infinity,
    depth: createDepthScale(), depthLogged: null, depthRefusedAt: -Infinity,
  })

  /** A code let go: its anchors deleted, its depth scale forgotten, said untracked once if it was
   *  tracked. */
  const drop = (c: Code, say_: boolean) => {
    deleteAnchor(c.anchor)
    deleteAnchor(c.next)
    c.anchor = c.next = null
    c.asked = null   // (made later, it is not wanted: deleted at once)
    c.depth.reset()
    c.depthLogged = null
    if (say_) say(c, false, "no longer a target")
  }

  /** An observation of `c` into its depth scale (the picture's camera pose, the raw centre in the
   *  camera), said when an estimate taken moved by more than 0.5 % or one was refused. */
  const depthIn = (c: Code, view: ArrayLike<number>, centre: { x: number, y: number, z: number }, now: number) => {
    const { fit, taken } = c.depth.add(depthObservation(view, centre))
    if (!fit) return
    const clamped = fit.scale !== fit.unclamped ? `, clamped from ${fit.unclamped.toFixed(3)}` : ""
    const about = `baseline ${(fit.baseline * 100).toFixed(1)} cm, residual ${(fit.residual * 1000).toFixed(1)} mm, ${fit.n} obs${clamped}`
    if (taken) {
      if (c.depthLogged !== null && Math.abs(fit.scale - c.depthLogged) <= DEPTH_LOG_CHANGE * c.depthLogged) return
      c.depthLogged = fit.scale
      console.log(`[ar] qr ${c.target.text}: depth scale ${c.depth.scale.toFixed(3)} (estimate ${fit.scale.toFixed(3)}, ${about})`)
    } else if (now - c.depthRefusedAt >= KEPT_LOG_PERIOD) {
      c.depthRefusedAt = now
      console.log(`[ar] qr ${c.target.text}: depth scale estimate ${fit.scale.toFixed(3)} refused (${about}; the residual over ${(DEPTH_SCALE.maxResidual * 1000).toFixed(0)} mm), the scale stays ${c.depth.scale.toFixed(3)}`)
    }
  }

  type Phase = "seeking" | "holding" | "waiting"
  const phaseOf = (c: Code): Phase => c.asked || c.next ? "waiting" : c.anchor && c.anchorTracked ? "holding" : "seeking"

  /** An anchor at `pose` for `c`, made in the next frame: it becomes `next`, promoted when tracked. */
  const askAnchor = (c: Code, pose: Pose) => {
    const mine = generation
    const wait: AnchorWait = {
      pose,
      wanted: () => mine === generation && c.asked === wait && codes.includes(c),
      settle: (anchor) => {
        if (c.asked !== wait) { deleteAnchor(anchor); return }
        c.asked = null
        if (!anchor) return   // none made: the entity stays where it was put, the code seeks again
        deleteAnchor(c.next)
        c.next = anchor
        c.nextFrames = 0
      },
    }
    c.asked = wait
    host.anchor(wait)
  }

  /** The pose of an anchor in this frame: null when it is not tracked (or gone). */
  const poseIn = (frame: XRFrame, local: XRReferenceSpace, anchor: XRAnchor): Pose | null => {
    try {
      if (frame.trackedAnchors && !frame.trackedAnchors.has(anchor)) return null
      const at = frame.getPose(anchor.anchorSpace, local)
      return at ? transformPose(at.transform) : null
    } catch {
      return null
    }
  }

  /** The anchors of this frame: a new one promoted at its first pose, the entity driven. */
  const drive = (frame: XRFrame, local: XRReferenceSpace) => {
    for (const c of codes) {
      if (c.next) {
        if (poseIn(frame, local, c.next)) {
          const old = c.anchor
          c.anchor = c.next
          c.next = null
          c.anchorTracked = false
          deleteAnchor(old)
          // from where it is shown to the new anchor (a first anchor is where it was put: a glide of nothing)
          c.slew = c.shown ? { from: c.shown, frame: 0 } : null
        } else if (++c.nextFrames > NEW_ANCHOR_FRAMES) {
          console.warn(`[ar] qr ${c.target.text}: the new anchor was not tracked in ${NEW_ANCHOR_FRAMES} frames: given up`)
          deleteAnchor(c.next)
          c.next = null
        }
      }
      if (!c.anchor) continue
      const at = poseIn(frame, local, c.anchor)
      if (!at) {
        if (c.anchorTracked) {
          c.anchorTracked = false
          say(c, false, "lost (its anchor is not tracked)")
        }
        continue
      }
      c.anchorTracked = true
      c.anchorPose = at
      let shown = at
      if (c.slew) {
        c.slew.frame++
        shown = interpolate(c.slew.from, at, Math.min(1, c.slew.frame / SLEW_FRAMES))
        if (c.slew.frame >= SLEW_FRAMES) c.slew = null
      }
      c.shown = shown
      host.setMatrix(c.target.entity, compose(shown))
      say(c, true, "regained (its anchor is tracked again)")
    }
  }

  /** An observation of `c` in a picture: M = the picture's view × matrix_gl, matrix_gl's translation
   *  scaled by the code's depth scale (the observation, raw, in its window first). */
  const observed = (c: Code, o: Float64Array, p: Pending, processMs: number, resultFrames: number) => {
    const { picture } = p
    const side = o[1]!, rms = o[2]!, inliers = o[3]!
    const gl = o.subarray(4, 20)
    const now = performance.now()
    c.misses = 0
    if (inliers < MIN_INLIERS) {
      if (now - c.keptLoggedAt >= KEPT_LOG_PERIOD) {
        c.keptLoggedAt = now
        console.log(`[ar] qr ${c.target.text}: ignored (${inliers} points < ${MIN_INLIERS}; side ${side.toFixed(0)} px of ${picture.width}, rms ${rms.toFixed(2)} px)`)
      }
      return
    }
    if (rms <= CONFIG.max_rms_px) depthIn(c, picture.viewMatrix, { x: gl[12]!, y: gl[13]!, z: gl[14]! }, now)
    // the centre along its ray by the code's depth scale, the rotation kept
    const k = c.depth.scale
    const scaled = Array.from(gl)
    scaled[12] = gl[12]! * k; scaled[13] = gl[13]! * k; scaled[14] = gl[14]! * k
    const m = multiply(picture.viewMatrix, scaled)
    const pose = poseOf(m)
    c.corners = Array.from(o.subarray(20, 28))
    c.cornersIn = [picture.width, picture.height]
    c.side = side
    /** the side in px of a HOLD_WIDTH-wide picture: the sides of both phases compared */
    const at640 = side * HOLD_WIDTH / picture.width
    if (now - c.loggedAt >= LOG_PERIOD) {
      c.loggedAt = now
      console.log(`[ar] qr ${c.target.text}: side ${side.toFixed(0)} px of ${picture.width}, rms ${rms.toFixed(2)} px, inliers ${inliers}, t=(${gl[12]!.toFixed(3)} ${gl[13]!.toFixed(3)} ${gl[14]!.toFixed(3)}) m, the picture after ${p.capturedAt - p.askedAt} frames, the result after ${resultFrames}, worker ${processMs.toFixed(1)} ms`)
    }
    const phase = phaseOf(c)
    if (phase === "waiting") return
    if (phase === "seeking") {
      // found (or found again, its anchor lost): put there at once, an anchor asked for there
      if (c.anchor) { deleteAnchor(c.anchor); c.anchor = null; c.anchorPose = null }
      c.slew = null
      c.shown = pose
      c.bestSide = at640
      host.setMatrix(c.target.entity, m)
      say(c, true, `found at (${pose.position.x.toFixed(3)} ${pose.position.y.toFixed(3)} ${pose.position.z.toFixed(3)}) m`)
      if (host.anchors()) askAnchor(c, pose)
      return
    }
    // holding: the observation against the anchor
    const held = c.anchorPose!
    const dm = distance(pose.position, held.position), dd = angle(pose.rotation, held.rotation)
    const verdict = replaceVerdict({ metres: dm, degrees: dd, side: at640, rms, inliers }, c.bestSide)
    const delta = `Δ ${(dm * 1000).toFixed(1)} mm, ${dd.toFixed(2)}°`
    if (verdict === "near") {
      c.bestSide = Math.max(c.bestSide, at640)
    } else if (verdict === "kept") {
      if (now - c.keptLoggedAt >= KEPT_LOG_PERIOD) {
        c.keptLoggedAt = now
        console.log(`[ar] qr ${c.target.text}: kept (side ${at640.toFixed(0)} < ${SIDE_RATIO} × ${c.bestSide.toFixed(0)} px), ${delta} (rms ${rms.toFixed(2)} px)`)
      }
    } else if (verdict === "replace" || verdict === "move") {
      console.log(`[ar] qr ${c.target.text}: anchor replaced${verdict === "move" ? " (a large Δ)" : ""}, ${delta} (side ${at640.toFixed(0)} px, best ${c.bestSide.toFixed(0)}, rms ${rms.toFixed(2)} px)`)
      c.bestSide = at640
      askAnchor(c, pose)
    }
  }

  /** The worker's word: ready, failed, or a picture's result. */
  const heard = (message: FromQRWorker) => {
    revokeBlob()
    if (message.type === "ready") {
      ready = true
      console.log(`[ar] qr: qr-anchor ${message.version} loaded in its worker in ${message.ms.toFixed(0)} ms`)
      return
    }
    if (message.type === "failed") { lost(message.message); return }
    const p = pending
    if (!p || message.seq !== p.seq) return
    pending = null
    inFlight = false
    const o = message.observations
    const n = Math.floor(o.length / STRIDE)
    const resultFrames = frames - p.askedAt
    if (summary.since && p.phase === summary.phase) {
      summary.captures++
      summary.workerMs += message.processMs
      summary.captureFrames += p.capturedAt - p.askedAt
      summary.resultFrames += resultFrames
      if (n > 0) summary.found++
    }
    if (p.stale) return
    if (p.phase === "holding") {
      const seen = new Set<number>()
      for (let k = 0; k < n; k++) seen.add(o[k * STRIDE]!)
      codes.forEach((c, i) => { if (!seen.has(i) && phaseOf(c) === "holding") c.misses++ })
    }
    for (let k = 0; k < n; k++) {
      const record = o.subarray(k * STRIDE, (k + 1) * STRIDE)
      const c = codes[record[0]!]
      if (c) observed(c, record, p, message.processMs, resultFrames)
    }
  }

  /** A capture back: handed to the worker (its bytes transferred), with the windows of the held
   *  codes in its pixels. */
  const send = (picture: CameraGray, phase: QRWorkerPhase, askedAt: number) => {
    if (!worker || !ready) { inFlight = false; return }
    const { width, height } = picture
    const p = picture.projection
    if (!described.has(width)) {
      described.add(width)
      // the intrinsics the detector derives (qr-anchor's Intrinsics::from_gl_projection)
      const fx = p[0]! * width / 2, fy = p[5]! * height / 2, cx = (1 - p[8]!) * width / 2 - 0.5, cy = (1 + p[9]!) * height / 2 - 0.5
      console.log(`[ar] qr: the capture is ${width}×${height} gray (seeking ${SEEK_WIDTH} px / holding ${HOLD_WIDTH} px, worker), fx ${fx.toFixed(1)} fy ${fy.toFixed(1)} cx ${cx.toFixed(1)} cy ${cy.toFixed(1)} px`)
    }
    // the windows: where each held code IS in this picture — its anchor's corners projected through
    // the picture's view (the camera moved since the code was last seen: where it was seen is stale);
    // where it was last seen when the anchor is not there yet
    const hints: QRWorkerHint[] = []
    const inverseView = invert(picture.viewMatrix)
    codes.forEach((c, i) => {
      if (phaseOf(c) !== "holding") return
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      let side = 0
      const held = c.anchorPose
      if (held && inverseView) {
        const m = compose(held), h = c.target.size / 2
        for (const [ax, az] of [[-h, -h], [h, -h], [h, h], [-h, h]] as const) {
          // the corner in the world: the anchor's X along the top edge, Z towards the bottom
          const wx = m[0]! * ax + m[8]! * az + m[12]!, wy = m[1]! * ax + m[9]! * az + m[13]!, wz = m[2]! * ax + m[10]! * az + m[14]!
          const px = projectToPixels({ x: wx, y: wy, z: wz }, p, inverseView, width, height)
          if (!px) { x0 = Infinity; break }
          x0 = Math.min(x0, px[0]); x1 = Math.max(x1, px[0]); y0 = Math.min(y0, px[1]); y1 = Math.max(y1, px[1])
        }
        side = Math.max(x1 - x0, y1 - y0)
      }
      if (!(x0 < Infinity) && c.corners) {
        const sx = width / c.cornersIn[0], sy = height / c.cornersIn[1]
        x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity
        for (let k = 0; k < 4; k++) {
          const x = c.corners[2 * k]! * sx, y = c.corners[2 * k + 1]! * sy
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
        }
        side = c.side * Math.max(sx, sy)
      }
      if (!(x0 < Infinity)) return
      const margin = HINT_MARGIN * side
      hints.push([i, Math.floor(x0 - margin), Math.floor(y0 - margin), Math.ceil(x1 + margin), Math.ceil(y1 + margin)])
    })
    // the engine's buffer is the capture's own: handed over, not copied (a part of one is copied first)
    const data = picture.data
    const gray = (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer) as ArrayBuffer
    const s = ++seq
    pending = { seq: s, phase, picture, askedAt, capturedAt: frames, stale: false }
    post({ type: "frame", seq: s, phase, gray, width, height, p0: p[0]!, p5: p[5]!, p8: p[8]!, p9: p[9]!, hints }, [gray])
  }

  /** Is this frame's camera moving slowly (since the last frame)? */
  const slowly = (viewer: Pose): boolean => {
    const last = lastViewer
    lastViewer = viewer
    return !!last && distance(viewer.position, last.position) < SLOW_METRES && angle(viewer.rotation, last.rotation) < SLOW_DEGREES
  }

  const mean = (sum: number, n: number, digits: number) => (n ? sum / n : 0).toFixed(digits)

  return {
    /** The session's codes (a start's, a setCodes'): the set replaces the one before — a code no
     *  longer listed loses its anchor (`tracked: false` once if it was tracked), a new one seeks. A
     *  code is the same when its entity, text and size are. The first code makes the worker. */
    setCodes(set: QRTarget[]) {
      const next = set.map((t) => codes.find((c) => c.target.entity === t.entity && c.target.text === t.text && c.target.size === t.size) ?? newCode(t))
      for (const c of codes) if (!next.includes(c)) drop(c, true)
      const changed = next.length !== codes.length || next.some((c, i) => c !== codes[i])
      codes = next
      if (changed) {
        if (pending) pending.stale = true
        post({ type: "targets", targets: targetsOf() })
      }
      ensureWorker()
    },

    /** The session's frame (after the app's anchors, before the render): the anchors drive their
     *  entities, a capture is asked for when one is due. */
    frame(frame: XRFrame, local: XRReferenceSpace | null, pose: XRViewerPose | null) {
      frames++
      if (codes.length === 0 || !local) return
      drive(frame, local)
      const view = pose?.views[0]
      if (!pose || !view || pose.emulatedPosition) { lastViewer = null; return }
      const slow = slowly(transformPose(pose.transform))
      sinceCapture++
      const phases = codes.map(phaseOf)
      // sought: not held, or held and missed by the window for a while (its anchor kept)
      const seeking = codes.some((c, i) => phases[i] === "seeking" || (phases[i] === "holding" && c.misses >= MISSES_TO_SEEK))
      if (seeking || phases.includes("holding")) {
        const now = performance.now()
        const phase: QRWorkerPhase = seeking ? "seeking" : "holding"
        if (!summary.since || summary.phase !== phase) {
          summary.phase = phase
          restartSummary(now)
        } else if (now - summary.since >= SEEK_LOG_PERIOD) {
          const n = summary.captures
          const scales = codes.map((c) => codes.length > 1 ? `${c.target.text} ${c.depth.scale.toFixed(3)}` : c.depth.scale.toFixed(3)).join(", ")
          console.log(`[ar] qr: ${phase} — ${n} captures in ${((now - summary.since) / 1000).toFixed(0)} s, ${summary.found} with a code, the picture after ${mean(summary.captureFrames, n, 1)} frames, the result after ${mean(summary.resultFrames, n, 1)}, worker ${mean(summary.workerMs, n, 1)} ms mean, depth scale ${scales}${codes.some((c) => c.misses >= MISSES_TO_SEEK) ? `, sought again after ${MISSES_TO_SEEK} misses` : ""}`)
          restartSummary(now)
        }
      } else summary.since = 0
      if (inFlight || !ready) return
      let due: boolean
      if (seeking) {
        due = sinceCapture >= SEEK_EVERY
      } else {
        // sooner while a held code's depth scale is not estimated yet
        const every = codes.some((c, i) => phases[i] === "holding" && c.depth.estimate === null) ? HOLD_EVERY_CALIBRATING : HOLD_EVERY
        const inverse = sinceCapture >= every && slow ? invert(view.transform.matrix) : null
        due = !!inverse && codes.some((c, i) => phases[i] === "holding" && c.anchorPose && projectsInside(c.anchorPose.position, view.projectionMatrix, inverse))
      }
      if (!due) return
      sinceCapture = 0
      inFlight = true
      const mine = generation
      const askedAt = frames
      const phase: QRWorkerPhase = seeking ? "seeking" : "holding"
      host.capture(seeking ? SEEK_WIDTH : HOLD_WIDTH).then((picture) => {
        if (mine !== generation) return
        if (picture) send(picture, phase, askedAt)
        else inFlight = false
      }, (e: unknown) => {
        if (mine !== generation) return
        inFlight = false
        console.warn(`[ar] qr: the capture failed (${said(e)})`)
      })
    },

    /** The session's end: every code and anchor gone, the worker ended. `dead` = the session
     *  ended by itself: its anchors go with it, untouched. */
    clear(dead = false) {
      generation++
      sessionGone = dead
      try { for (const c of codes) drop(c, false) } finally { sessionGone = false }
      codes = []
      stopWorker()
      failed = false
      sinceCapture = 0
      lastViewer = null
      described.clear()
      restartSummary(0)
    },
  }
}

export type QRTracker = ReturnType<typeof createQRTracker>
