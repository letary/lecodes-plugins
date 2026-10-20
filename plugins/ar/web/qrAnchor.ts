// ar on the web, the WebXR arm's QR targets (`StartOptions.codes` / `setCodes`, ./webxr.ts drives
// this): a printed QR code of known text and size, found in the camera's picture and kept in the
// room by an anchor of the session.
//
// Who knows what. The camera's pose is ARCore's (the session's `local` space, the viewer's pose of
// each frame). The detector — qr-anchor, a Rust library as wasm (./qr-anchor/, its README names the
// commit that built it) — knows nothing of the room: from a gray picture of the camera and the
// picture's intrinsics (the view's projection at the picture's size) it finds the symbol and its pose
// in the camera, `matrix_gl` (the marker's frame in the GL camera: the symbol's centre, X along its
// top edge, Y out of it, Z towards its bottom, metres — the contract's frame of a code's entity). So
//
//   M = view.transform.matrix × matrix_gl     (column-major; the view = the camera of that picture)
//
// is the code in the session's space. M places the entity at once, and an XRAnchor made at M (the
// next frame: createAnchor needs one) holds it from then on — ARCore keeps it true as its map of the
// room improves, the picture is not looked at for that.
//
// The cadence (per XR frame with a pose; never two captures out at once). A capture is
// `captureCamera({ gray: true, maxWidth: 640 })` of the presentation — the frame it is served in, its
// projection and its view pose come with it (the pose of THAT frame is the one M uses):
//   - SEEKING (a code with no anchor, or its anchor lost): a capture every 2nd frame;
//   - HOLDING (every code's anchor stands): every 15th frame at most, and only when a held code's
//     centre projects inside the view and the camera moves slowly (under 2 cm and 2° since the last
//     frame: a blurred picture gives a worse pose than the anchor has); the detector gets the last
//     observation's corners as its window (set_hint). An observation more than 1 cm or 1° off the
//     anchor's pose (and good: rms ≤ max_rms_px, side ≥ min_reacquire_side_px) REPLACES the anchor:
//     a new one at the observed pose; when it is first tracked the old one is deleted and the entity
//     glides from where it was shown to the new anchor over SLEW_FRAMES frames (the position along the
//     line, the turn along the arc) — never a jump;
//   - while an anchor is asked for or not yet tracked, the code waits (its observations ignored).
// Each frame an anchor is tracked its pose drives the entity. Not in `frame.trackedAnchors` (once it
// was): `image { tracked: false }` once; tracked again: `tracked: true`. `extent` = [size, size].
//
// The wasm (300 KB) is fetched when the first code is set, not before: its URL is the manifest's
// resource `qrAnchorWasm` (`web.resources`, `as: "url"`: the host's bundler hands it), the glue
// (./qr-anchor/qr_anchor_wasm.js) a chunk of its own. One module per page, one detector session per
// arm (`reset` at the session's end).
//
// The device log (the dev server's): an accepted observation `[ar] qr <text>: side … px, rms … px,
// inliers …, t=(x y z) m, … ms (capture … + process …)` (t = the code's centre in the camera, GL axes:
// x right, y up, −z ahead; at most 2 lines a second), a replacement's delta (mm, °), a loss and a
// regain, the first capture's size and intrinsics, and every 5 s while seeking how many captures
// found what.

import type { Pose, QRTarget } from "./ar.gen"
import { angle, compose, distance, interpolate, invert, multiply, poseOf, projectsInside } from "./pose"
import type { AnchorWait, CameraGray } from "./webxr"

/** The detector's parameters (qr-anchor's `Params`, its README): the defaults but the gates. */
const CONFIG = {
  /** the smallest apparent side of a code's first observation (px of the 640-wide picture) */
  min_init_side_px: 40,
  /** … once it was observed in this session */
  min_reacquire_side_px: 20,
  /** the largest RMS reprojection error of the inliers (the library's default is 1.0) */
  max_rms_px: 0.6,
}
/** The capture's width (px): the camera's picture shrunk to it (the aspect kept). */
const CAPTURE_WIDTH = 640
/** Frames between captures: seeking, holding. */
const SEEK_EVERY = 2
const HOLD_EVERY = 15
/** The camera "moves slowly" between two frames: under these. */
const SLOW_METRES = 0.02
const SLOW_DEGREES = 2
/** An observation this far off its anchor's pose replaces the anchor. */
const REPLACE_METRES = 0.01
const REPLACE_DEGREES = 1
/** Frames a replaced anchor's entity glides over. */
const SLEW_FRAMES = 10
/** Frames a new anchor may take to be tracked before it is given up. */
const NEW_ANCHOR_FRAMES = 30
/** The window around the last observation's corners, × its side. */
const HINT_MARGIN = 0.5
/** The observation log: at most this many lines a second per code. */
const LOG_PERIOD = 500
/** The seeking summary's period, ms. */
const SEEK_LOG_PERIOD = 5000
/** The output of qr-anchor (layout 1): 28 f64 per observation. */
const LAYOUT = 1
const STRIDE = 28

/** What the manifest's `web.resources` hands this half (build/plugins.ts of the host). */
export type ARWebResources = { qrAnchorWasm?: string }

/** What the tracker is handed by the arm. */
export type QRTrackerHost = {
  setMatrix(entity: number, m16: ArrayLike<number>): void
  image(payload: { entity: number, tracked: boolean, extent: number[] }): void
  /** The gray picture of this frame (the presentation's captureCamera), null when there is none. */
  capture(maxWidth: number): Promise<CameraGray | null>
  /** An anchor at a pose of the session's space, made in the next frame (./webxr.ts's anchorAt). */
  anchor(wait: AnchorWait): void
  /** The session makes anchors ("anchors" granted); without them an entity stays where it was put. */
  anchors(): boolean
  /** The wasm's URL (the manifest's resource), asked for with the first code. */
  wasmUrl(): Promise<string | undefined>
}

type Glue = typeof import("./qr-anchor/qr_anchor_wasm.js")
type Wasm = { glue: Glue, memory: WebAssembly.Memory }

/** The page's one module: loaded with the first code of any session, a failure said once. */
let loading: Promise<Wasm | null> | null = null
const loadWasm = (url: () => Promise<string | undefined>): Promise<Wasm | null> => loading ??= (async () => {
  try {
    const [glue, href] = await Promise.all([import("./qr-anchor/qr_anchor_wasm.js"), url()])
    const t0 = performance.now()
    const out = await (href ? glue.default({ module_or_path: href }) : glue.default())
    if (glue.output_layout_version() !== LAYOUT || glue.output_stride() !== STRIDE) {
      throw new Error(`its output is layout ${glue.output_layout_version()} × ${glue.output_stride()}, this half reads ${LAYOUT} × ${STRIDE}`)
    }
    console.log(`[ar] qr: qr-anchor ${glue.version()} loaded in ${(performance.now() - t0).toFixed(0)} ms`)
    return { glue, memory: out.memory }
  } catch (e) {
    console.warn(`[ar] the QR detector did not load (${e instanceof Error ? e.message : e}): QR codes are not tracked`)
    return null
  }
})()

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
  side: number
  loggedAt: number
}

const transformPose = (t: XRRigidTransform): Pose => ({
  position: { x: t.position.x, y: t.position.y, z: t.position.z },
  rotation: { x: t.orientation.x, y: t.orientation.y, z: t.orientation.z, w: t.orientation.w },
})

const deleteAnchor = (anchor: XRAnchor | null) => {
  try { anchor?.delete() } catch { /* the session's gone */ }
}

/** The QR targets of one WebXR arm. */
export const createQRTracker = (host: QRTrackerHost) => {
  let codes: Code[] = []
  /** Moves at each `clear`: a capture or an anchor of before is not wanted. */
  let generation = 0
  let wasm: Wasm | null = null
  let detector: InstanceType<Glue["QrAnchor"]> | null = null
  let inFlight = false
  let sinceCapture = 0
  let lastViewer: Pose | null = null
  /** The session's first capture is described once. */
  let described = false
  const seekLog = { since: 0, captures: 0, found: 0, processMs: 0 }

  const extent = (c: Code) => [c.target.size, c.target.size]
  const say = (c: Code, tracked: boolean, why: string) => {
    if (c.tracked === tracked) return
    c.tracked = tracked
    console.log(`[ar] qr ${c.target.text}: ${why}`)
    host.image({ entity: c.target.entity, tracked, extent: extent(c) })
  }

  /** The detector's targets: the codes in their order (an observation names its code by it). */
  const sendTargets = () => {
    if (!detector) return
    try {
      detector.set_targets(JSON.stringify(codes.map((c) => ({ text: c.target.text, size: c.target.size }))))
    } catch (e) {
      console.warn(`[ar] qr: the detector refused the codes (${e instanceof Error ? e.message : e}): they are not tracked`)
    }
  }

  const ensureDetector = () => {
    if (detector || codes.length === 0) return
    void loadWasm(host.wasmUrl).then((w) => {
      if (!w || detector) return
      wasm = w
      try {
        detector = new w.glue.QrAnchor(JSON.stringify(CONFIG))
      } catch (e) {
        console.warn(`[ar] qr: the detector refused its parameters (${e instanceof Error ? e.message : e}): QR codes are not tracked`)
        return
      }
      sendTargets()
    })
  }

  const newCode = (target: QRTarget): Code => ({
    target, anchor: null, anchorPose: null, anchorTracked: false, asked: null, next: null, nextFrames: 0,
    shown: null, tracked: false, slew: null, corners: null, cornersIn: [0, 0], side: 0, loggedAt: -Infinity,
  })

  /** A code let go: its anchors deleted, said untracked once if it was tracked. */
  const drop = (c: Code, say_: boolean) => {
    deleteAnchor(c.anchor)
    deleteAnchor(c.next)
    c.anchor = c.next = null
    c.asked = null   // (made later, it is not wanted: deleted at once)
    if (say_) say(c, false, "no longer a target")
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

  /** An observation of `c` in a picture: M = the picture's view × matrix_gl. */
  const observed = (c: Code, o: number[], picture: CameraGray, captureMs: number, processMs: number) => {
    const side = o[1]!, rms = o[2]!, inliers = o[3]!
    const gl = o.slice(4, 20)
    const m = multiply(picture.viewMatrix, gl)
    const pose = poseOf(m)
    c.corners = o.slice(20, 28)
    c.cornersIn = [picture.width, picture.height]
    c.side = side
    const now = performance.now()
    if (now - c.loggedAt >= LOG_PERIOD) {
      c.loggedAt = now
      console.log(`[ar] qr ${c.target.text}: side ${side.toFixed(0)} px, rms ${rms.toFixed(2)} px, inliers ${inliers}, t=(${gl[12]!.toFixed(3)} ${gl[13]!.toFixed(3)} ${gl[14]!.toFixed(3)}) m, ${(captureMs + processMs).toFixed(1)} ms (capture ${captureMs.toFixed(1)} + process ${processMs.toFixed(1)})`)
    }
    const phase = phaseOf(c)
    if (phase === "waiting") return
    if (phase === "seeking") {
      // found (or found again, its anchor lost): put there at once, an anchor asked for there
      if (c.anchor) { deleteAnchor(c.anchor); c.anchor = null; c.anchorPose = null }
      c.slew = null
      c.shown = pose
      host.setMatrix(c.target.entity, m)
      say(c, true, `found at (${pose.position.x.toFixed(3)} ${pose.position.y.toFixed(3)} ${pose.position.z.toFixed(3)}) m`)
      if (host.anchors()) askAnchor(c, pose)
      return
    }
    // holding: the observation against the anchor
    const held = c.anchorPose!
    const dm = distance(pose.position, held.position), dd = angle(pose.rotation, held.rotation)
    if ((dm > REPLACE_METRES || dd > REPLACE_DEGREES) && rms <= CONFIG.max_rms_px && side >= CONFIG.min_reacquire_side_px) {
      console.log(`[ar] qr ${c.target.text}: anchor replaced, Δ ${(dm * 1000).toFixed(1)} mm, ${dd.toFixed(2)}° (side ${side.toFixed(0)} px, rms ${rms.toFixed(2)} px)`)
      askAnchor(c, pose)
    }
  }

  /** A capture back: the detector over it, its observations taken. */
  const process = (picture: CameraGray, askedAt: number) => {
    const d = detector, w = wasm
    if (!d || !w || codes.length === 0) return
    const t0 = performance.now()
    const captureMs = t0 - askedAt
    const { width, height } = picture
    const p = picture.projection
    if (!described) {
      described = true
      // the intrinsics the detector derives (qr-anchor's Intrinsics::from_gl_projection)
      const fx = p[0]! * width / 2, fy = p[5]! * height / 2, cx = (1 - p[8]!) * width / 2 - 0.5, cy = (1 + p[9]!) * height / 2 - 0.5
      console.log(`[ar] qr: the capture is ${width}×${height} gray, fx ${fx.toFixed(1)} fy ${fy.toFixed(1)} cx ${cx.toFixed(1)} cy ${cy.toFixed(1)} px`)
    }
    const at = d.frame_ptr(width, height)
    if (!at) { console.warn(`[ar] qr: the detector takes no ${width}×${height} picture`); return }
    // (a view of the memory each time: it may have grown)
    new Uint8Array(w.memory.buffer, at, width * height).set(picture.data)
    // the windows: where each held code was last seen, in this picture's pixels
    codes.forEach((c, i) => {
      if (phaseOf(c) !== "holding" || !c.corners) return
      const sx = width / c.cornersIn[0], sy = height / c.cornersIn[1]
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let k = 0; k < 4; k++) {
        const x = c.corners[2 * k]! * sx, y = c.corners[2 * k + 1]! * sy
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      }
      const margin = HINT_MARGIN * c.side * Math.max(sx, sy)
      d.set_hint(i, Math.floor(x0 - margin), Math.floor(y0 - margin), Math.ceil(x1 + margin), Math.ceil(y1 + margin))
    })
    const n = d.process_gl(p[0]!, p[5]!, p[8]!, p[9]!)
    const processMs = performance.now() - t0
    // copied out before anything is called again (a call may grow the memory)
    const out = Array.from(new Float64Array(w.memory.buffer, d.output_ptr(), d.output_len()))
    const seeking = codes.some((c) => phaseOf(c) === "seeking")
    if (seeking) {
      seekLog.captures++
      seekLog.processMs += processMs
      if (n > 0) seekLog.found++
    }
    for (let k = 0; k < n; k++) {
      const o = out.slice(k * STRIDE, (k + 1) * STRIDE)
      const c = codes[o[0]!]
      if (c) observed(c, o, picture, captureMs, processMs)
    }
  }

  /** Is this frame's camera moving slowly (since the last frame)? */
  const slowly = (viewer: Pose): boolean => {
    const last = lastViewer
    lastViewer = viewer
    return !!last && distance(viewer.position, last.position) < SLOW_METRES && angle(viewer.rotation, last.rotation) < SLOW_DEGREES
  }

  return {
    /** The session's codes (a start's, a setCodes'): the set replaces the one before — a code no
     *  longer listed loses its anchor (`tracked: false` once if it was tracked), a new one seeks. A
     *  code is the same when its entity, text and size are. */
    setCodes(set: QRTarget[]) {
      const next = set.map((t) => codes.find((c) => c.target.entity === t.entity && c.target.text === t.text && c.target.size === t.size) ?? newCode(t))
      for (const c of codes) if (!next.includes(c)) drop(c, true)
      codes = next
      sendTargets()
      ensureDetector()
    },

    /** The session's frame (after the app's anchors, before the render): the anchors drive their
     *  entities, a capture is asked for when one is due. */
    frame(frame: XRFrame, local: XRReferenceSpace | null, pose: XRViewerPose | null) {
      if (codes.length === 0 || !local) return
      drive(frame, local)
      const view = pose?.views[0]
      if (!pose || !view || pose.emulatedPosition) { lastViewer = null; return }
      const slow = slowly(transformPose(pose.transform))
      sinceCapture++
      if (inFlight || !detector) return
      const phases = codes.map(phaseOf)
      let due: boolean
      if (phases.includes("seeking")) {
        due = sinceCapture >= SEEK_EVERY
        const now = performance.now()
        if (!seekLog.since) seekLog.since = now
        if (now - seekLog.since >= SEEK_LOG_PERIOD) {
          const mean = seekLog.captures ? seekLog.processMs / seekLog.captures : 0
          console.log(`[ar] qr: seeking — ${seekLog.captures} captures in ${((now - seekLog.since) / 1000).toFixed(0)} s, ${seekLog.found} with a code, process ${mean.toFixed(1)} ms mean`)
          seekLog.since = now
          seekLog.captures = seekLog.found = 0
          seekLog.processMs = 0
        }
      } else {
        seekLog.since = 0
        const inverse = sinceCapture >= HOLD_EVERY && slow ? invert(view.transform.matrix) : null
        due = !!inverse && codes.some((c, i) => phases[i] === "holding" && c.anchorPose && projectsInside(c.anchorPose.position, view.projectionMatrix, inverse))
      }
      if (!due) return
      sinceCapture = 0
      inFlight = true
      const mine = generation
      const askedAt = performance.now()
      host.capture(CAPTURE_WIDTH).then((picture) => {
        if (mine !== generation) return
        inFlight = false
        if (picture) process(picture, askedAt)
      }, (e: unknown) => {
        if (mine !== generation) return
        inFlight = false
        console.warn(`[ar] qr: the capture failed (${e instanceof Error ? e.message : e})`)
      })
    },

    /** The session's end: every code and anchor gone, the detector's history reset. */
    clear() {
      generation++
      for (const c of codes) drop(c, false)
      codes = []
      inFlight = false
      sinceCapture = 0
      lastViewer = null
      described = false
      seekLog.since = seekLog.captures = seekLog.found = 0
      seekLog.processMs = 0
      try {
        detector?.set_targets("[]")
        detector?.reset()
      } catch { /* a detector that refuses an empty set has nothing to forget */ }
    },
  }
}

export type QRTracker = ReturnType<typeof createQRTracker>
