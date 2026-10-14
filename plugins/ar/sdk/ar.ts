// ARScene — world tracking over the device camera, on the "ar" plugin: a Scene whose camera and
// background a host SESSION drives every frame (ARKit on iOS, ARCore on Android, the browser's camera
// turned by the sensors on the web).
//
// Hand-written over the generated wire because what an app holds is not the wire: the anchors and the
// planes are NODES of the scene (`Anchor extends Node`, `ARPlane extends Anchor`), kept here by their
// entity / plane id and moved by the session's events; the session is the scene's, opened by `open()`
// — the camera permission and a warm render first, while the current destination stays on screen —
// and closed by `close()`. `open()` resolves at the first frame drawn of the presented scene, not at
// the present (a host mounts and sizes the scene's view after it). A host without the plugin is
// refused before anything is asked.
//
// `root` is a pose anchor like any other (`scene.anchor(pose)`): the wrapper pins it on the first
// horizontal plane the session reports, so the halves know no root.

import {
  Geometry, Mat4, Material, Mesh, Node, Presentable, Quat, Scene, System, Vec3, _ensurePermission, _navEpoch, _toFile,
  type ClickEvent, type DismissOptions, type FetchResponse, type File, type NodeEvents, type PresentOptions,
  type QuatLike, type SceneOptions, type TouchStartEvent, type Vec3Like,
} from "lecodes-sdk/plugin"
import { ARBase, supports } from "./ar.gen"
import { attachControls, type ControlsHandle, type ControlsOptions } from "./controls"
import type {
  ARErrorCode, ARMode, HitTarget, ImageTarget, PlaneChange, PlaneDetection, PlaneType, Pose, StartOptions,
  TrackingReason, TrackingState, WorldAlignment,
} from "../contract"

export type {
  ARErrorCode, ARMode, ControlsHandle, ControlsOptions, HitTarget, PlaneChange, PlaneDetection, PlaneType, TrackingReason,
  TrackingState, WorldAlignment,
}

/** A pose in the scene's world: metres, Y up. */
export type ARPose = { position: Vec3, rotation: Quat }
/** A pose as `scene.anchor()` takes it. */
export type ARPoseLike = { position: Vec3Like, rotation: QuatLike }

/** What `scene.hitTest()` finds under a point, nearest first. */
export type ARHitResult = {
  pose: ARPose
  /** "plane": on a detected plane (`plane`); "estimated": on a point of the feature cloud or an
   *  estimated surface. */
  type: "plane" | "estimated"
  plane: ARPlane | null
  /** Metres from the camera. */
  distance: number
}

/** The estimated light (`lightEstimation`): an ambient intensity (1000 = neutral) and a colour
 *  temperature in kelvin. */
export type ARLightEstimate = { intensity: number, temperature: number }

/** The session failed and is over: "unavailable" (no ARKit / ARCore, ARCore declined), "camera",
 *  "failed". */
export type ARError = { code: ARErrorCode, message: string }

/** A plane found, moved or grown, or gone (`mergedInto`: the plane that absorbed it). */
export type ARPlaneEvent = { plane: ARPlane, change: PlaneChange, mergedInto: ARPlane | null }

export type ARSceneOptions = SceneOptions & {
  /** "world" (default): planes, hit tests, anchors, image targets. "images": image targets only —
   *  lighter on iOS; no planes, no hit test, no `root`. */
  mode?: ARMode
}

export type AROpenOptions = PresentOptions & Omit<StartOptions, "mode" | "images"> & {
  /** The scene's ambient (its `environmentIntensity`) follows the estimated light; turns
   *  `lightEstimation` on. */
  followLight?: boolean
}

export type ARSceneEvents = {
  tracking: (state: TrackingState, reason: TrackingReason | null) => void
  plane: (event: ARPlaneEvent) => void
  light: (estimate: ARLightEstimate) => void
  error: (error: ARError) => void
}

export type AnchorEvents = NodeEvents & {
  /** The anchor began tracking: found, placed, or regained after a relocalization. */
  track: () => void
  /** The anchor lost tracking: it stays where it was last seen. */
  untrack: () => void
}

/** A wire pose → the app's. */
const poseOf = (w: Pose): ARPose => ({
  position: new Vec3(w.position.x, w.position.y, w.position.z),
  rotation: new Quat(w.rotation.x, w.rotation.y, w.rotation.z, w.rotation.w),
})
/** …and back. */
const wirePose = (p: ARPoseLike): Pose => {
  const v = new Vec3(p.position), q = new Quat(p.rotation)
  return { position: { x: v.x, y: v.y, z: v.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } }
}

/**
 * A node the AR session drives: it follows a place in the room (`scene.anchor(pose)`, `scene.root`)
 * or an image (`scene.createAnchor(image)`). Put content under it. `tracked` says whether the session
 * holds it now; `track` / `untrack` fire when that changes.
 */
export class Anchor extends Node {
  /** @internal */
  _tracked = false
  /** @internal Hidden while not tracked (an image's: where it is is unknown until it is seen). */
  _hideUntracked = false
  /** @internal The scene whose session holds it. */
  _scene: ARScene | null = null

  /** Whether the session holds the anchor now (it moves with what it follows). */
  get tracked(): boolean { return this._tracked }

  override addEventListener<K extends keyof AnchorEvents>(channel: K, callback: AnchorEvents[K]): void {
    super.addEventListener(channel as keyof NodeEvents, callback as never)
  }
  override removeEventListener<K extends keyof AnchorEvents>(channel: K, callback: AnchorEvents[K]): void {
    super.removeEventListener(channel as keyof NodeEvents, callback as never)
  }

  /** Stop following: the session lets it go (it stays where it was) and it leaves the scene. */
  remove(): void {
    this._scene?._removeAnchor(this)
  }

  /** @internal */
  _setTracked(tracked: boolean): void {
    if (this._hideUntracked) this.visible = tracked
    if (this._tracked === tracked) return
    this._tracked = tracked
    ;(this.dispatch as (channel: string) => void).call(this, tracked ? "track" : "untrack")
  }
}

/**
 * An anchor that follows an image (`scene.createAnchor(image, physicalWidth)`): while tracked it sits on
 * the image — a rigid pose in metres, no scale: its centre, Y out of the image, the image in X (its
 * width) and Z (towards its bottom). How big the image is, is `extent`.
 */
export class ImageAnchor extends Anchor {
  /** @internal */
  _extent: [number, number]

  constructor(physicalWidth: number) {
    super()
    this._extent = [physicalWidth, 0]
  }

  /** [width, height] in metres, along the anchor's X and Z: the session's estimate of the printed
   *  image, refined while it tracks it. Before the image is first found: [physicalWidth, 0] — the
   *  height comes with the image's proportions, which the session reads, at the first `track`. */
  get extent(): [number, number] { return [this._extent[0], this._extent[1]] }
}

/** A surface the session found: a floor, a table, a wall. Its node sits at the plane's centre with Y
 *  along its normal; `extent` and `polygon` are in that space. */
export class ARPlane extends Anchor {
  /** The session's id of the plane (`ARHitResult.plane`, `mergedInto`). */
  readonly planeId: number
  /** @internal */
  _type: PlaneType = "horizontal"
  /** @internal */
  _extent: [number, number] = [0, 0]
  /** @internal */
  _polygon: number[] = []
  /** @internal */
  _grid: Mesh | null = null

  constructor(planeId: number) {
    super()
    this.planeId = planeId
  }

  get type(): PlaneType { return this._type }
  /** [width, depth] in metres, along the plane's X and Z. */
  get extent(): [number, number] { return [this._extent[0], this._extent[1]] }
  /** The boundary as x, z pairs in the plane's space (metres). */
  get polygon(): readonly number[] { return this._polygon }
  /** The plane's centre in the world. */
  get center(): Vec3 { return this.worldPosition }
}

/** One grid material for every plane drawn: white lines. */
let gridMaterial: Material | null = null

/** A plane's grid: its outline and lines every `step` metres across it, cut to the polygon (a
 *  scanline per line), as edges a millimetre above the plane in its own space. */
const gridGeometry = (polygon: readonly number[], step = 0.1): Geometry => {
  const segs: number[] = []
  const n = polygon.length >> 1
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const x = polygon[2 * i]!, z = polygon[2 * i + 1]!
    const j = (i + 1) % n
    segs.push(x, z, polygon[2 * j]!, polygon[2 * j + 1]!)
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  // lines along X at each z, then along Z at each x: where the line crosses the outline, in pairs
  const cut = (along: 0 | 1, from: number, to: number) => {
    for (let c = Math.ceil(from / step) * step, lines = 0; c <= to && lines < 200; c += step, lines++) {
      const hits: number[] = []
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const a0 = polygon[2 * i + (1 - along)]!, a1 = polygon[2 * j + (1 - along)]!
        if ((a0 <= c) === (a1 <= c)) continue
        const b0 = polygon[2 * i + along]!, b1 = polygon[2 * j + along]!
        hits.push(b0 + (c - a0) / (a1 - a0) * (b1 - b0))
      }
      hits.sort((p, q) => p - q)
      for (let k = 0; k + 1 < hits.length; k += 2) {
        if (along === 0) segs.push(hits[k]!, c, hits[k + 1]!, c)
        else segs.push(c, hits[k]!, c, hits[k + 1]!)
      }
    }
  }
  if (n >= 3) { cut(0, minZ, maxZ); cut(1, minX, maxX) }
  const count = segs.length / 2
  const vertices = new Float32Array(count * 3), normals = new Float32Array(count * 3)
  const indices = new Uint16Array(count), uv = new Float32Array(count * 2)
  for (let v = 0; v < count; v++) {
    vertices[3 * v] = segs[2 * v]!; vertices[3 * v + 1] = 0.001; vertices[3 * v + 2] = segs[2 * v + 1]!
    normals[3 * v + 1] = 1
    indices[v] = v
  }
  const geometry = new Geometry(vertices, normals, indices, uv)
  geometry.kind = "edges"
  return geometry
}

/** The first frame of a presented ARScene: a System — the scene-wide per-frame hook, ticked in the
 *  late phase of every frame the engine draws, and the engine draws only the scene on show, once its
 *  view has a surface and a size — attached by `_presented()`, gone at its first tick. */
class FirstFrame extends System<"arFirstFrame", ARScene> {
  // a paused game still draws its scene: the wait is not the game's
  protected override updateWhilePaused = true
  protected override update(): void { this.scene._framed() }
}

/**
 * A 3D scene over the device camera with world tracking: the session (the "ar" plugin) moves
 * `scene.camera` and draws the camera image behind everything, every frame. Everything of `Scene`
 * applies. `ARScene.isSupported` says whether this host has the plugin.
 *
 * ```ts
 * const scene = new ARScene()
 * scene.root.add(await Model.load(asset('./chair.glb')))
 * await scene.open()          // camera permission → warm render → session → on screen, drawn
 * ```
 */
export class ARScene extends Scene {
  /** Whether this host registered the "ar" service (the app lists the plugin, the host has a half). */
  static get isSupported(): boolean { return supports() }

  readonly mode: ARMode
  /** `open()` warm-renders the scene first (default true). */
  useWarmRender = true

  /** @internal The running session, null when there is none. */
  _session: ARBase | null = null
  private _opening: Promise<void> | null = null
  /** The wait of `open()` / `Router.push` for the presented scene's first frame (`_presented`), and
   *  the navigation epoch of its present. */
  private _shown: { promise: Promise<void>, resolve: () => void, reject: (error: Error) => void, epoch: number } | null = null
  /** The open's start while it is out (`_begin`). `closed`: close() ended its session meanwhile — the
   *  half refuses a start its close cut short ("failed"), which is the close's doing: the open was
   *  superseded, not failed. `images`: the image targets changed meanwhile, which the start did not
   *  carry (it read them when it was sent) — the set goes to the session once it runs. */
  private _startOut: { session: ARBase, closed: boolean, images: boolean } | null = null
  /** A `setImages` is due at the end of this turn (`_setImages`). */
  private _imagesDue = false
  private _options: AROpenOptions = {}
  private _root: Anchor | null = null
  /** The first horizontal plane's pose: where `root` is pinned. */
  private _floor: ARPose | null = null
  /** The image targets. `source` is held for the bytes: a fetched response owns its buffer, which the
   *  host frees once the response is collected — the File the session is handed only names it. */
  private readonly _images: { anchor: ImageAnchor, image: File, width: number, source: FetchResponse | File }[] = []
  /** The pose anchors: pinned again where they are when a session starts. (`root` is not one: a
   *  session pins it on its own first floor.) */
  private readonly _pinned = new Set<Anchor>()
  private readonly _planes = new Map<number, ARPlane>()
  private _trackingState: TrackingState = "notAvailable"
  private _trackingReason: TrackingReason | null = null
  private _light: ARLightEstimate | null = null
  private _showPlanes = false
  private _baseIntensity = 0
  private readonly _arListeners: { [K in keyof ARSceneEvents]?: ARSceneEvents[K][] } = {}

  constructor(options: ARSceneOptions = {}) {
    super(options)
    this.mode = options.mode ?? "world"
  }

  /** The tracking quality: "notAvailable" before a session, "limited" (with `trackingReason`) while
   *  it settles or struggles, "normal". */
  get trackingState(): TrackingState { return this._trackingState }
  get trackingReason(): TrackingReason | null { return this._trackingReason }
  /** The planes the session holds now. */
  get planes(): ARPlane[] { return [...this._planes.values()] }
  /** The latest light estimate (`lightEstimation`), null before one. */
  get lightEstimate(): ARLightEstimate | null { return this._light }

  /** A grid drawn on every plane (each plane's child mesh). */
  get showPlanes(): boolean { return this._showPlanes }
  set showPlanes(on: boolean) {
    this._showPlanes = on
    for (const plane of this._planes.values()) this._drawPlane(plane)
  }

  /** The floor: an anchor pinned on the first horizontal plane the session finds (it fires `track`
   *  then). Until that it is the world's origin — where the session began. Not in "images" mode. */
  get root(): Anchor {
    if (this._root) return this._root
    if (this.mode === "images") throw new Error('ARScene.root: there is no root in the "images" mode')
    const root = new Anchor()
    root._scene = this
    this.add(root)
    this._root = root
    if (this._floor) this._pinRoot(this._floor)
    return root
  }

  /** An anchor that follows an image (a printed marker, a poster): the session finds it in the camera
   *  image and keeps the anchor on it — a rigid pose in metres (its centre, Y out of the image, the
   *  image in XZ), its size `anchor.extent`. `physicalWidth` = the printed width in metres. Hidden
   *  while not tracked. Before `open()`, or any time: on a running scene the image set is updated in
   *  place — the tracking, the planes and the anchors stay. */
  createAnchor(source: FetchResponse | File, physicalWidth = 0.2): ImageAnchor {
    const anchor = new ImageAnchor(physicalWidth)
    anchor._scene = this
    anchor._hideUntracked = true
    anchor.visible = false
    this.add(anchor)
    const id = (source as unknown as { _h: Handle })._h.id
    this._images.push({ anchor, image: _toFile({ systemId: id, name: "image", size: 0 }), width: physicalWidth, source })
    this._setImages()
    return anchor
  }

  /** An anchor at `pose` (a hit test's, say): the session keeps it where it is in the room as its
   *  map of the world improves. `anchor.remove()` lets it go. */
  anchor(pose: ARPoseLike): Anchor {
    const anchor = new Anchor()
    anchor._scene = this
    this.add(anchor)
    this._place(anchor, pose)
    return anchor
  }

  /** What is under a point of the scene's view, nearest first — the point as the scene's touches
   *  give it (`ev.clientX` / `ev.clientY` of a `click` or a `touchstart`); empty when nothing is — and
   *  always on the web, which finds no surfaces. Rejects without a running session. */
  async hitTest(x: number, y: number, target?: HitTarget): Promise<ARHitResult[]> {
    const hits = await this._wire("hitTest", session => session.hitTest(x, y, target))
    return hits.map(h => ({
      pose: poseOf(h.pose), type: h.type, distance: h.distance,
      plane: h.plane === undefined ? null : this._planes.get(h.plane) ?? null,
    }))
  }

  /** The latest camera image as a JPEG `File` (the camera's alone; `capture()` is the composite).
   *  Rejects without a running session. */
  captureFrame(): Promise<File> {
    return this._wire("captureFrame", session => session.captureFrame())
  }

  /**
   * Let the user place & manipulate a node with touch gestures — the staple AR object-placement
   * interaction: ONE finger drags it over what the session finds under the finger (a plane), or across
   * the ground where it finds nothing; TWO fingers pinch to scale and twist to rotate. Returns a
   * handle; `.remove()` detaches. Tunable via options (min/max scale, `pan` / `pinch` / `twist`).
   */
  addControls(target: Node, options: ControlsOptions = {}): ControlsHandle {
    return attachControls(this, target, options)
  }

  // ---- presenting ----

  /** Camera permission → warm render → the session → on screen, resolved at the scene's first frame:
   *  after `await scene.open()` the scene is shown, `camera.displaySize` is its view's size, and
   *  `hitTest` / `captureFrame` answer. The current destination (a loading screen) stays until the
   *  session runs; rejects — and leaves it — when the camera is denied, AR is unavailable
   *  ("unavailable": no ARKit / ARCore), or another navigation came meanwhile; one that comes before
   *  the first frame (a `close()` too) rejects it as superseded. */
  override async open(options: AROpenOptions = {}): Promise<void> {
    this._options = options
    await this._prepare()
    super.open(options)
    await this._presented()
  }

  /** @internal Presentable prepare hook (Router.push / replace await it, with the options of the last
   *  `open()`). */
  _prepare(): Promise<void> {
    if (!ARScene.isSupported) {
      return Promise.reject(new Error('ARScene isn\'t available on this host — it needs the "ar" plugin (app.json "plugins").'))
    }
    if (this._opening) return this._opening                     // one preparation at a time
    if (this._session) return Promise.resolve()                    // running: a pop back to it presents it again
    const opening = this._begin()
    this._opening = opening
    opening.then(() => { if (this._opening === opening) this._opening = null }, () => { if (this._opening === opening) this._opening = null })
    return opening
  }

  /** @internal Presentable's after-present hook (`open()`, Router.push / replace): resolves in the
   *  first frame drawn of this scene. A host mounts the scene's view after the present and sizes it
   *  later still (Android's surface): at the present `camera.displaySize` read 0 × 0 and a hit test
   *  had no viewport; in that frame both are known, and the session's frame is drawn. Rejects as
   *  superseded when the scene left the screen first. */
  _presented(): Promise<void> {
    // the epoch of this present: a close event of an EARLIER presentation (the runtime's events come
    // later) finds it unmoved and is not one
    const epoch = _navEpoch()
    const shown = this._shown
    if (shown) {
      shown.epoch = epoch   // two opens at once: one wait, the last present's
      return shown.promise
    }
    let resolve!: () => void, reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    this._shown = { promise, resolve, reject, epoch }
    this.system(FirstFrame)
    return promise
  }

  /** @internal FirstFrame's tick: a frame was drawn — this scene's while it is the one on show. */
  _framed(): void {
    this._settleShown(Presentable.current === this ? null : "another destination was opened")
  }

  private _settleShown(superseded: string | null): void {
    const shown = this._shown
    if (!shown) return
    this._shown = null
    this.removeSystem(FirstFrame)
    if (superseded === null) shown.resolve()
    else shown.reject(new Error(`ARScene.open() superseded before the scene's first frame: ${superseded}`))
  }

  /** Close the scene; its session stops (the camera is let go). An `open()` still waiting — for the
   *  session's start or the first frame — rejects as superseded. */
  override close(options?: DismissOptions): void {
    this._settleShown("the scene was closed")
    // a start still out ends with this session: the half's refusal of it is this close's (_begin)
    const out = this._startOut
    if (out && out.session === this._session) out.closed = true
    this._end()
    super.close(options)
  }

  /** @internal The scene left the screen (replaced, covered, closed: the runtime's lifecycle event).
   *  A wait for its first frame is over — no frame of it comes now. The session stays: its life is
   *  `close()`'s, as after a resolved open() (a covered scene comes back with a pop). */
  override _emitClose(): void {
    if (this._shown && _navEpoch() !== this._shown.epoch) this._settleShown("another destination was opened")
    super._emitClose()
  }

  // ---- events ----

  override addEventListener(channel: "click", callback: (ev: ClickEvent<Node | null>) => void): void
  override addEventListener(channel: "touchstart", callback: (ev: TouchStartEvent<Node | null>) => void): void
  override addEventListener<K extends keyof ARSceneEvents>(channel: K, callback: ARSceneEvents[K]): void
  override addEventListener(channel: string, callback: (...args: any[]) => void): void {
    if (channel === "click" || channel === "touchstart") { super.addEventListener(channel as "click", callback); return }
    const list = (this._arListeners[channel as keyof ARSceneEvents] ??= []) as ((...args: any[]) => void)[]
    if (!list.includes(callback)) list.push(callback)
  }
  override removeEventListener(channel: "click" | "touchstart" | keyof ARSceneEvents, callback: (...args: any[]) => void): void {
    if (channel === "click" || channel === "touchstart") { super.removeEventListener(channel, callback); return }
    const list = this._arListeners[channel] as ((...args: any[]) => void)[] | undefined
    const at = list ? list.indexOf(callback) : -1
    if (at >= 0) list!.splice(at, 1)
  }
  private _emit<K extends keyof ARSceneEvents>(channel: K, ...args: Parameters<ARSceneEvents[K]>): void {
    for (const fn of (this._arListeners[channel] ?? []).slice()) (fn as (...a: any[]) => void)(...args)
  }

  // ---- the session ----

  private _startOptions(): StartOptions {
    const { transition: _t, followLight, ...rest } = this._options
    const options: StartOptions = { ...rest, mode: this.mode }
    if (followLight) options.lightEstimation = true
    if (this._images.length) options.images = this._targets()
    return options
  }

  private _targets(): ImageTarget[] {
    return this._images.map(t => ({ image: t.image, physicalWidth: t.width, entity: t.anchor }))
  }

  private async _begin(): Promise<void> {
    const epoch = _navEpoch()
    const superseded = (why = "another destination was opened") => new Error(`ARScene.open() superseded: ${why} while preparing`)
    await _ensurePermission("camera")
    if (this.useWarmRender) await this.warmRender()
    if (_navEpoch() !== epoch) throw superseded()   // (a close() too: no session for a scene that went)
    const session = new ARBase({ scene: this, camera: this.camera })
    session.on("tracking", p => {
      if (this._session !== session || !p) return
      this._trackingState = p.state
      this._trackingReason = p.reason ?? null
      this._emit("tracking", p.state, this._trackingReason)
    })
    session.on("plane", p => { if (this._session === session && p) this._onPlane(p) })
    session.on("image", p => {
      if (this._session !== session || !p || !(p.entity instanceof ImageAnchor)) return
      if (p.extent.length >= 2) p.entity._extent = [p.extent[0]!, p.extent[1]!]
      p.entity._setTracked(p.tracked)
    })
    session.on("anchor", p => { if (this._session === session && p && p.entity instanceof Anchor) p.entity._setTracked(p.tracked) })
    session.on("light", p => {
      if (this._session !== session || !p) return
      this._light = { intensity: p.intensity, temperature: p.temperature }
      if (this._options.followLight) this.environmentIntensity = this._baseIntensity * p.intensity / 1000
      this._emit("light", this._light)
    })
    session.on("error", p => {
      if (this._session !== session || !p) return
      this._drop(session)
      this._emit("error", { code: p.code, message: p.message })
    })
    this._session = session
    this._baseIntensity = this.environmentIntensity
    const out = { session, closed: false, images: false }
    this._startOut = out
    try {
      await session.start(this._startOptions())
    } catch (e) {
      // closed while it started: every half's end() refuses a start still out ("failed") — the open
      // was superseded, it did not fail; close() closed the session, once
      if (out.closed) throw superseded("the scene was closed")
      this._drop(session)
      throw e
    } finally {
      if (this._startOut === out) this._startOut = null
    }
    if (this._session !== session) throw superseded("the scene was closed")
    if (_navEpoch() !== epoch) {
      this._drop(session)
      throw superseded()
    }
    this._pinAll()
    // the image targets changed while the start was out: the running session takes the set now
    if (out.images) this._setImages()
  }

  /** The session is over (closed, failed): every anchor untracked, the planes gone. */
  private _drop(session: ARBase): void {
    if (this._session !== session) return
    this._session = null
    session.close()
    this._lost()
  }

  private _end(): void {
    const session = this._session
    if (session) this._drop(session)
  }

  private _lost(): void {
    this._trackingState = "notAvailable"
    this._trackingReason = null
    this._light = null
    this._floor = null
    for (const plane of this._planes.values()) { plane._setTracked(false); this.remove(plane) }
    this._planes.clear()
    for (const anchor of this._pinned) anchor._setTracked(false)
    for (const image of this._images) image.anchor._setTracked(false)
    this._root?._setTracked(false)
    if (this._options.followLight) this.environmentIntensity = this._baseIntensity
  }

  /** The image targets changed (one added or removed): a running session takes the whole set in place
   *  (`setImages` — the tracking, the planes and the anchors stay). Sent at the end of the turn: several
   *  targets added in a row are one set. While the open's start is out it waits for it (the start
   *  carried the set it read when it was sent); before a session there is nothing to tell — the start
   *  carries the set. Nothing waits for it: a set the half refuses is a console line, and an anchor
   *  whose image the session did not take never tracks. */
  private _setImages(): void {
    const session = this._session
    if (!session) return
    const out = this._startOut
    if (out && out.session === session) { out.images = true; return }
    if (this._imagesDue) return
    this._imagesDue = true
    void Promise.resolve().then(() => {
      this._imagesDue = false
      // closed meanwhile: a call on the closed channel would open a new session (the next open's start
      // carries the set)
      if (this._session !== session) return
      session.setImages(this._targets()).catch((e: unknown) => {
        // a close while it was out: the half's refusal is the close's, nothing failed
        if (this._session !== session) return
        console.warn(`ARScene: the session did not take the image targets (${e instanceof Error ? e.message : String(e)}) — their anchors are not tracked`)
      })
    })
  }

  /** A wire call to the running session; rejects without one. */
  private _wire<T>(name: string, call: (session: ARBase) => Promise<T>): Promise<T> {
    const session = this._session
    if (!session) return Promise.reject(new Error(`ARScene.${name}(): no session — open() the scene first`))
    return call(session)
  }

  /** Pin `anchor` at `pose` (where it is until the session holds it) — now, or when a session starts. */
  private _place(anchor: Anchor, pose: ARPoseLike): void {
    anchor.worldMatrix = Mat4.compose(pose.position, pose.rotation)
    this._pinned.add(anchor)
    this._pin(anchor, pose)
  }

  /** `root` onto the floor (the first horizontal plane of this session). */
  private _pinRoot(pose: ARPose): void {
    const root = this._root!
    root.worldMatrix = Mat4.compose(pose.position, pose.rotation)
    this._pin(root, pose)
  }

  private _pin(anchor: Anchor, pose: ARPoseLike): void {
    const session = this._session
    if (!session) return
    const wire = wirePose(pose)
    this._wire("anchor", s => s.anchor(anchor, wire)).then(() => { if (this._session === session) anchor._setTracked(true) }, () => {})
  }

  /** A session began: every pose anchor is pinned where it is. */
  private _pinAll(): void {
    for (const anchor of this._pinned) {
      const m = anchor.worldMatrix
      this._pin(anchor, { position: m.position, rotation: m.rotation })
    }
  }

  /** @internal anchor.remove() */
  _removeAnchor(anchor: Anchor): void {
    this._pinned.delete(anchor)
    if (anchor === this._root) this._root = null
    const image = this._images.findIndex(t => t.anchor === anchor)
    if (image >= 0) this._images.splice(image, 1)
    this._wire("release", s => s.release(anchor)).catch(() => {})
    anchor._setTracked(false)
    this.remove(anchor)
    if (image >= 0) this._setImages()
  }

  private _onPlane(p: { change: PlaneChange, id: number, type: PlaneType, pose: Pose, extent: number[], polygon: number[], mergedInto?: number }): void {
    let plane = this._planes.get(p.id)
    if (p.change === "removed") {
      if (!plane) return
      this._planes.delete(p.id)
      plane._setTracked(false)
      this.remove(plane)
      const into = p.mergedInto === undefined ? null : this._planes.get(p.mergedInto) ?? null
      this._emit("plane", { plane, change: "removed", mergedInto: into })
      return
    }
    const added = !plane
    if (!plane) {
      plane = new ARPlane(p.id)
      plane._scene = this
      this._planes.set(p.id, plane)
      this.add(plane)
    }
    const pose = poseOf(p.pose)
    plane.matrix = Mat4.compose(pose.position, pose.rotation)
    plane._type = p.type
    plane._extent = [p.extent[0] ?? 0, p.extent[1] ?? 0]
    plane._polygon = p.polygon
    plane._setTracked(true)
    this._drawPlane(plane)
    // the floor: the first horizontal plane, where root is pinned
    if (added && p.type === "horizontal" && !this._floor) {
      this._floor = pose
      if (this._root) this._pinRoot(pose)
    }
    this._emit("plane", { plane, change: added ? "added" : "updated", mergedInto: null })
  }

  private _drawPlane(plane: ARPlane): void {
    if (!this._showPlanes) {
      if (plane._grid) plane._grid.visible = false
      return
    }
    const geometry = gridGeometry(plane._polygon)
    if (plane._grid) {
      plane._grid.setGeometry(geometry)
      plane._grid.visible = true
    } else {
      plane._grid = new Mesh(geometry, gridMaterial ??= Material.unlit({ color: "#ffffff" }))
      plane.add(plane._grid)
    }
  }
}
