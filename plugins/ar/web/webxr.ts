// ar on the web, the WebXR arm: an `immersive-ar` session — Chrome on Android, over ARCore — where
// the browser has one (./ar.ts picks it at start). SLAM: the device is tracked in the room, its
// position too, in metres; what `anchor()` pins stays where it was put, and is kept true by the
// session's anchors. Nothing is FOUND: no plane, no image (a marker is a later step), so the `plane`
// and `image` events never come; `hitTest` answers the session's hit tests (on the surfaces ARCore
// estimates); `light` comes from its light estimate.
//
// Who draws what. The camera is the BROWSER's: it composites the session's layer over it. The host's
// engine draws the scene into that layer (`gl.presentXR`, Web Lite's alone — a host without it, the
// web player, gets the plain arm) and sets the scene's camera and projection from the viewer's pose
// each frame: this half calls neither setCameraMatrix nor setProjection. The page's UI is the DOM:
// it stays on screen as the session's DOM overlay (the page's body), over the camera and the scene;
// the scene's canvas is in it, transparent, and still takes the scene's touches. A tap on the overlay
// is the page's, never an XR `select` (`beforexrselect` is refused).
//
// The world is the session's `local` space: the origin where the session began, −Z the heading it
// began with, Y up, metres — the contract's. `gravityAndHeading` has no compass here: gravity alone.
//
// The frame. The engine's XR frame calls `onXRFrame` after it set the camera and before it renders:
// the tracking state, the anchors' poses (each frame), the hit tests and the anchors asked for since
// the last frame (they need an XRFrame), the light. `start` resolves at the session's first frame —
// ARScene presents its scene after it: until then, and while the scene is covered, the camera alone
// shows under the page.
//
// `requestSession` needs the tap that opened the scene (a user activation, a few seconds long): a
// camera prompt answered slowly before it (the SDK's camera permission) can outlast it — "denied".
//
// The channel is the contract's (../contract.d.ts): ar.gen.ts is generated from it, this file
// implements its ARPlugin for one session, through the host's gl facade alone.

import {
  ARError, type ARParams, type AREvents, type ARPlugin, type HitResult, type HitTarget, type ImageTarget, type PluginFile,
  type PluginGL, type Pose, type StartOptions, type TrackingReason, type TrackingState,
} from "./ar.gen"

/** The camera's picture of a frame, RGBA8, the top row first. */
type CameraImage = { rgba: Uint8Array, width: number, height: number }

/** What `presentXR` hands back (lecodes-web-shared's XRPresentation, as a shape). */
export type XRPresentation = {
  /** Leave the session's frames (the session goes on). */
  end(): void
  /** The camera's picture of the next frame; null without the `camera-access` feature. */
  captureCamera(): Promise<CameraImage | null>
}

/** The host's gl facade with its WebXR member — Web Lite's (lecodes-web-shared's GLFacade);
 *  absent on a host without it. The generated PluginGL does not name it: the half reads it here. */
export type XRGL = PluginGL & {
  presentXR?(scene: number, session: XRSession, space: XRReferenceSpace, onFrame: (time: number, frame: XRFrame, pose: XRViewerPose | null) => void): Promise<XRPresentation>
}

// Light estimation (the WebXR module, not in @types/webxr)
type LightProbe = EventTarget
type LightEstimate = { readonly primaryLightIntensity: DOMPointReadOnly }
type LightSession = { requestLightProbe?(options?: { reflectionFormat?: string }): Promise<LightProbe> }
type LightFrame = { getLightEstimate?(probe: LightProbe): LightEstimate | null }

const OPTIONAL_FEATURES = ["hit-test", "anchors", "dom-overlay", "camera-access", "light-estimation"]
/** How many frames a hit test waits for its source's first results: a new source may answer a
 *  frame or two after it is made. */
const HIT_FRAMES = 4
/** The light event's period, ms: at most 10 a second. */
const LIGHT_PERIOD = 100

const warned = new Set<string>()
const warnOnce = (what: string, message: string) => {
  if (warned.has(what)) return
  warned.add(what)
  console.warn(`[ar] ${message}`)
}

/** Does this page have the WebXR arm: a WebXR AR session the browser can make, a host engine that
 *  draws into one. Asked at a start (no prompt: the browser answers what it has). */
export const webxrSupported = async (gl: XRGL): Promise<boolean> => {
  const xr = typeof navigator === "undefined" ? undefined : navigator.xr
  if (!xr || typeof gl.presentXR !== "function") return false
  try { return await xr.isSessionSupported("immersive-ar") } catch { return false }
}

/** A pose as a column-major 4×4 world matrix. */
const compose = ({ position: p, rotation: q }: Pose): number[] => {
  const { x, y, z, w } = q
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0,
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0,
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0,
    p.x, p.y, p.z, 1,
  ]
}

/** The inverse of a column-major 4×4 matrix; null when it has none. */
const invert = (m: ArrayLike<number>): number[] | null => {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m)
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return null
  const d = 1 / det
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ]
}

/** A point of clip space (x, y, z, 1) taken back through an inverse projection. */
const unproject = (inv: number[], x: number, y: number, z: number): [number, number, number] => {
  const w = inv[3]! * x + inv[7]! * y + inv[11]! * z + inv[15]!
  return [
    (inv[0]! * x + inv[4]! * y + inv[8]! * z + inv[12]!) / w,
    (inv[1]! * x + inv[5]! * y + inv[9]! * z + inv[13]!) / w,
    (inv[2]! * x + inv[6]! * y + inv[10]! * z + inv[14]!) / w,
  ]
}

type HitWait = { source: XRHitTestSource, frames: number, resolve: (hits: HitResult[]) => void, reject: (e: ARError) => void }
type AnchorWait = { entity: number, pose: Pose, resolve: () => void, reject: (e: ARError) => void }
type Anchored = { anchor: XRAnchor, tracked: boolean, seen: boolean }

/** The WebXR arm of one session (`registerAR`'s make). */
export const createWebXRArm = (gl: XRGL, params: ARParams, events: AREvents): ARPlugin => {
  const scene = params.scene
  let generation = 0
  let running = false
  let starting = false
  let session: XRSession | null = null
  let local: XRReferenceSpace | null = null
  let viewer: XRReferenceSpace | null = null
  let presentation: XRPresentation | null = null
  /** The start's wait for the session's first frame, settled once. */
  let first: ((error?: ARError) => void) | null = null
  /** The features the session was given (all of them asked for where the browser does not say). */
  let features = new Set<string>()
  let tracked = ""
  /** A pose came once (the reason of a later loss is "relocalizing"). */
  let seen = false
  /** The inverse of the last view's projection, and where the viewer was: the hit test's ray. */
  let inverseProjection: number[] | null = null
  let viewerAt: [number, number, number] = [0, 0, 0]
  let probe: LightProbe | null = null
  let lightAt = -Infinity
  let lightSent = -1
  /** Feature points as a hit test's target: the browser may take planes only. */
  let points = true
  let hits: HitWait[] = []
  let anchorsDue: AnchorWait[] = []
  /** The latest anchor() of each entity whose XRAnchor is not made yet. */
  const pinned = new Map<number, AnchorWait>()
  const anchors = new Map<number, Anchored>()

  const refuseSelect = (ev: Event) => ev.preventDefault()

  const track = (pose: XRViewerPose | null) => {
    let state: TrackingState = "normal"
    let reason: TrackingReason | undefined
    if (!pose || pose.emulatedPosition) {
      state = "limited"
      reason = seen ? "relocalizing" : "initializing"
    }
    if (pose && !pose.emulatedPosition) seen = true
    const key = `${state}:${reason ?? ""}`
    if (key === tracked) return
    tracked = key
    events.tracking(reason ? { state, reason } : { state })
  }

  const hitResults = (frame: XRFrame, source: XRHitTestSource): HitResult[] => {
    const out: HitResult[] = []
    for (const result of frame.getHitTestResults(source)) {
      const pose = local ? result.getPose(local) : undefined
      if (!pose) continue
      const p = pose.transform.position, q = pose.transform.orientation
      out.push({
        type: "estimated",
        pose: { position: { x: p.x, y: p.y, z: p.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } },
        distance: Math.hypot(p.x - viewerAt[0], p.y - viewerAt[1], p.z - viewerAt[2]),
      })
    }
    return out.sort((a, b) => a.distance - b.distance)
  }

  /** An anchor() served in a frame: the session's anchor at the pose (in `local`). Released or
   *  replaced before it is made, it is not wanted; one the session refuses leaves the node where
   *  setMatrix put it. */
  const anchorAt = (frame: XRFrame, wait: AnchorWait) => {
    if (pinned.get(wait.entity) !== wait) { wait.resolve(); return }
    const mine = generation
    const { position: p, rotation: q } = wait.pose
    let made: Promise<XRAnchor> | undefined
    try {
      made = local ? frame.createAnchor?.(new XRRigidTransform({ x: p.x, y: p.y, z: p.z, w: 1 }, { x: q.x, y: q.y, z: q.z, w: q.w }), local) : undefined
    } catch (e) {
      made = Promise.reject(e)
    }
    if (!made) {   // where setMatrix put it: the world holds it
      pinned.delete(wait.entity)
      wait.resolve()
      return
    }
    made.then((anchor) => {
      if (mine !== generation || pinned.get(wait.entity) !== wait) {
        anchor.delete()
        if (mine !== generation) wait.reject(new ARError("notRunning"))
        else wait.resolve()
        return
      }
      pinned.delete(wait.entity)
      anchors.set(wait.entity, { anchor, tracked: true, seen: false })
      wait.resolve()
    }, (e: unknown) => {
      warnOnce("anchor", `the session made no anchor (${e instanceof Error ? e.message : e}): an anchored node stays where it was put`)
      if (pinned.get(wait.entity) === wait) pinned.delete(wait.entity)
      if (mine !== generation) wait.reject(new ARError("notRunning"))
      else wait.resolve()
    })
  }

  const light = (time: number, frame: XRFrame) => {
    if (!probe || time - lightAt < LIGHT_PERIOD) return
    const estimate = (frame as XRFrame & LightFrame).getLightEstimate?.(probe)
    if (!estimate) return
    lightAt = time
    const i = estimate.primaryLightIntensity
    // the primary light's brightest channel, 1 = neutral → the contract's 1000
    const intensity = Math.max(i.x, i.y, i.z) * 1000
    if (Math.abs(intensity - lightSent) < 1) return
    lightSent = intensity
    // WebXR gives no colour temperature: daylight's
    events.light({ intensity, temperature: 6500 })
  }

  /** The session's frame (the engine's, after it set the camera, before the render). */
  const onXRFrame = (time: number, frame: XRFrame, pose: XRViewerPose | null) => {
    if (frame.session !== session) return
    track(pose)
    const view = pose?.views[0]
    if (pose && view) {
      inverseProjection = invert(view.projectionMatrix)
      const p = pose.transform.position
      viewerAt = [p.x, p.y, p.z]
    }
    // the anchors: driven while tracked, said when lost or regained
    for (const [entity, a] of anchors) {
      const tracking = frame.trackedAnchors ? frame.trackedAnchors.has(a.anchor) : true
      const at = tracking && local ? frame.getPose(a.anchor.anchorSpace, local) : undefined
      if (at) gl.setMatrix(entity, at.transform.matrix)
      const now = !!at
      if (now) a.seen = true
      if (now !== a.tracked && a.seen) {
        a.tracked = now
        events.anchor({ entity, tracked: now })
      }
    }
    if (anchorsDue.length) {
      const due = anchorsDue
      anchorsDue = []
      for (const wait of due) anchorAt(frame, wait)
    }
    if (hits.length) {
      hits = hits.filter((h) => {
        const found = hitResults(frame, h.source)
        if (found.length === 0 && ++h.frames < HIT_FRAMES) return true
        h.source.cancel()
        h.resolve(found)
        return false
      })
    }
    light(time, frame)
    first?.()
  }

  const end = () => {
    generation++
    running = false
    starting = false
    first?.(new ARError("failed"))
    presentation?.end()
    presentation = null
    const s = session
    session = null
    if (s) {
      s.removeEventListener("end", onSessionEnd)
      s.end().catch(() => {})   // (one that ended by itself refuses: nothing to do)
      if (scene !== undefined) gl.clearProjection(scene)   // the host's projection of the viewer
    }
    document.body?.removeEventListener("beforexrselect", refuseSelect)
    for (const h of hits) {
      try { h.source.cancel() } catch { /* the session's gone */ }
      h.reject(new ARError("notRunning"))
    }
    hits = []
    for (const wait of anchorsDue) wait.reject(new ARError("notRunning"))
    anchorsDue = []
    pinned.clear()
    for (const a of anchors.values()) {
      try { a.anchor.delete() } catch { /* the session's gone */ }
    }
    anchors.clear()
    local = null
    viewer = null
    features = new Set()
    tracked = ""
    seen = false
    inverseProjection = null
    viewerAt = [0, 0, 0]
    probe = null
    lightAt = -Infinity
    lightSent = -1
  }

  /** The session ended by itself (the user left it, the browser took it back): the contract's
   *  `error` — the session is over. */
  const onSessionEnd = () => {
    const wasRunning = running
    end()
    if (wasRunning) events.error({ code: "failed", message: "the AR session ended" })
  }

  return {
    async start(options?: StartOptions) {
      if (running || starting) throw new ARError("busy")
      if (scene === undefined || params.camera === undefined) {
        console.warn("[ar] start: the session has no scene or camera to drive (ARScene opens it with both)")
        throw new ARError("failed")
      }
      const xr = navigator.xr
      const present = gl.presentXR
      if (!xr || !present) throw new ARError("unavailable")
      if (options?.mode === "images" || options?.images?.length) console.warn("[ar] the web finds no images in the camera's picture: their anchors are never tracked")
      if (options?.worldAlignment === "gravityAndHeading") warnOnce("heading", "WebXR has no compass: the world is aligned with gravity alone, −Z where the session began")
      starting = true
      const mine = ++generation
      let s: XRSession
      try {
        // first: inside the tap that opened the scene
        s = await xr.requestSession("immersive-ar", {
          requiredFeatures: ["local"],
          optionalFeatures: OPTIONAL_FEATURES,
          domOverlay: { root: document.body },
        })
      } catch (e) {
        if (mine === generation) starting = false
        const name = e instanceof Error ? e.name : ""
        console.warn(`[ar] no AR session: ${e instanceof Error ? e.message : e}`)
        throw new ARError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotSupportedError" ? "unavailable" : "failed")
      }
      if (mine !== generation) {
        s.end().catch(() => {})
        throw new ARError("failed")
      }
      session = s
      s.addEventListener("end", onSessionEnd)
      // a tap on the page (the DOM overlay) is the page's, not an XR select
      document.body.addEventListener("beforexrselect", refuseSelect)
      features = new Set(s.enabledFeatures ?? ["local", ...OPTIONAL_FEATURES])
      try {
        const world = await s.requestReferenceSpace("local")
        local = world
        viewer = await s.requestReferenceSpace("viewer")
        if (options?.lightEstimation) {
          const ask = (s as XRSession & LightSession).requestLightProbe
          if (features.has("light-estimation") && ask) {
            probe = await ask.call(s).catch((e: unknown) => {
              warnOnce("light", `no light estimate: ${e instanceof Error ? e.message : e}`)
              return null
            })
          } else warnOnce("light", "the AR session has no light estimate: no light event comes")
        }
        if (mine !== generation) throw new ARError("failed")
        const framed = new Promise<void>((resolve, reject) => {
          first = (error) => { first = null; if (error) reject(error); else resolve() }
        })
        const presented = await present.call(gl, scene, s, world, onXRFrame)
        if (mine !== generation) { presented.end(); throw new ARError("failed") }
        presentation = presented
        await framed
      } catch (e) {
        if (!(e instanceof ARError)) console.warn(`[ar] the AR session did not start: ${e instanceof Error ? e.message : e}`)
        if (mine === generation) end()
        throw e instanceof ARError ? e : new ARError("failed")
      }
      if (mine !== generation) throw new ARError("failed")
      starting = false
      running = true
    },

    stop() { end() },

    // nothing is found in the picture: a new set of images changes nothing (said as the start says it)
    setImages(images: ImageTarget[]) {
      if (!running) throw new ARError("notRunning")
      if (images.length) console.warn("[ar] the web finds no images in the camera's picture: their anchors are never tracked")
    },

    async hitTest(x: number, y: number, target?: HitTarget): Promise<HitResult[]> {
      const s = session
      if (!running || !s || !viewer || scene === undefined) throw new ARError("notRunning")
      if (!features.has("hit-test") || !s.requestHitTestSource) {
        warnOnce("hit-test", "the AR session has no hit test: hitTest finds nothing")
        return []
      }
      const view = gl.viewport(scene)
      const inv = inverseProjection
      if (!inv || !view.width || !view.height) return []
      // the ray through the point, in the viewer's space: the view's projection taken back
      const nx = (x / view.width) * 2 - 1, ny = 1 - (y / view.height) * 2
      const near = unproject(inv, nx, ny, -1), far = unproject(inv, nx, ny, 1)
      const direction = { x: far[0] - near[0], y: far[1] - near[1], z: far[2] - near[2], w: 0 }
      const ray = new XRRay({ x: 0, y: 0, z: 0, w: 1 }, direction)
      const mine = generation
      const ask = async (entityTypes: XRHitTestTrackableType[]) => s.requestHitTestSource!({ space: viewer!, offsetRay: ray, entityTypes })
      let source: XRHitTestSource | undefined
      try {
        source = await ask(target === "planes" || !points ? ["plane"] : ["plane", "point"])
      } catch (e) {
        if (target === "planes" || !points || mine !== generation) {
          warnOnce("hit-source", `the session made no hit test: ${e instanceof Error ? e.message : e}`)
          if (mine !== generation) throw new ARError("notRunning")
          return []
        }
        // a browser that tests against planes only
        points = false
        try { source = await ask(["plane"]) } catch (again) {
          warnOnce("hit-source", `the session made no hit test: ${again instanceof Error ? again.message : again}`)
        }
      }
      if (mine !== generation) { source?.cancel(); throw new ARError("notRunning") }
      if (!source) return []
      const made = source
      // answered by the next frames (a source's results come with a frame)
      return new Promise<HitResult[]>((resolve, reject) => { hits.push({ source: made, frames: 0, resolve, reject }) })
    },

    // where it is until the session's anchor holds it, then the anchor's pose every frame
    anchor(entity: number, pose: Pose): Promise<void> | void {
      if (!running || !session) throw new ARError("notRunning")
      gl.setMatrix(entity, compose(pose))
      if (!features.has("anchors")) {
        warnOnce("anchors", "the AR session has no anchors: an anchored node stays where it was put (the world map does not refine it)")
        return
      }
      const old = anchors.get(entity)
      if (old) {
        anchors.delete(entity)
        try { old.anchor.delete() } catch { /* gone */ }
      }
      return new Promise<void>((resolve, reject) => {
        const wait: AnchorWait = { entity, pose, resolve, reject }
        pinned.set(entity, wait)
        anchorsDue.push(wait)
      })
    },

    release(entity: number) {
      pinned.delete(entity)
      const a = anchors.get(entity)
      if (!a) return
      anchors.delete(entity)
      try { a.anchor.delete() } catch { /* the session's gone */ }
    },

    async captureFrame(): Promise<PluginFile> {
      const p = presentation
      if (!running || !p) throw new ARError("notRunning")
      const mine = generation
      const image = await p.captureCamera()
      if (mine !== generation) throw new ARError("notRunning")
      if (!image) {
        warnOnce("capture", "captureFrame: the AR session gives no camera picture (WebXR's camera-access: Chrome on Android, the camera allowed)")
        throw new ARError("failed")
      }
      const canvas = document.createElement("canvas")
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new ARError("failed")
      ctx.putImageData(new ImageData(new Uint8ClampedArray(image.rgba.buffer, image.rgba.byteOffset, image.rgba.byteLength), image.width, image.height), 0, 0)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9))
      if (!blob) throw new ARError("failed")
      return { data: await blob.arrayBuffer(), name: "frame.jpg" }
    },

    close() { end() },
  }
}
