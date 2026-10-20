// ar — world tracking over the device camera: ARKit on iOS, ARCore on Android, the camera under the
// scene turned by the sensors on the web. The app's side is ARScene (sdk/ar.ts), a Scene whose
// camera and background the session drives every frame through the host's gl facade.
// A session is ONE AR scene: ARScene opens it with the scene and its camera entity as params and
// closes it with the scene. `@permission camera` on start: the host asks, the halves never do.
// What a session finds in the camera's picture and drives an entity to: an image target (a printed
// picture, by its bytes) and, since contract version 2, a QR code (a printed symbol, by its text) —
// both through the `image` event. Codes are the web's (WebXR) first: the native halves take them and
// say they track none yet.
import type { Service, File, Entity, Scene3D, f64 } from "lecodes-sdk/plugin"

export type ARMode = "world" | "images"
export type PlaneDetection = "horizontal" | "vertical" | "both" | "none"
export type WorldAlignment = "gravity" | "gravityAndHeading"
export type TrackingState = "notAvailable" | "limited" | "normal"
export type TrackingReason = "initializing" | "excessiveMotion" | "insufficientFeatures" | "relocalizing"
export type PlaneType = "horizontal" | "vertical"
export type PlaneChange = "added" | "updated" | "removed"
export type HitTarget = "planes" | "estimated" | "any"
export type ARErrorCode = "unavailable" | "camera" | "failed"

export interface Vec3 { x: f64, y: f64, z: f64 }
export interface Quat { x: f64, y: f64, z: f64, w: f64 }
/** A pose in the scene's world: metres, Y up. */
export interface Pose { position: Vec3, rotation: Quat }

export interface ImageTarget {
  image: File
  /** The printed width, metres: the size the session starts from (the height by the image's
   *  proportions) — the framework refines it (the `image` event's `extent`). */
  physicalWidth: f64
  /** The entity that follows the image (its Anchor node). */
  entity: Entity
}

/** A printed QR code the session tracks: found by its text in the camera's picture; while
 *  tracked its entity is driven like an image target's — a rigid pose in metres, no scale — the
 *  symbol's centre, Y out of it, X along its top edge, Z towards its bottom. Web (WebXR) first;
 *  the native halves later. */
export interface QRTarget {
  /** The code's text: a symbol with another text is not this target. */
  text: string
  /** The printed side of the symbol (its modules, no quiet zone), metres. */
  size: f64
  /** The entity that follows the code (its Anchor node). */
  entity: Entity
}

export interface StartOptions {
  /** Default "world". "images": image tracking only (no planes, no hit test; iOS runs
   *  ARImageTrackingConfiguration, which is lighter). */
  mode?: ARMode
  /** Default "horizontal". Ignored in "images". */
  planes?: PlaneDetection
  images?: ImageTarget[]
  /** The QR codes to track (in "world" and in "images"); a half without them says so and drives
   *  none. @since 2 */
  codes?: QRTarget[]
  /** Default "gravity". "gravityAndHeading": -Z points north (the compass). */
  worldAlignment?: WorldAlignment
  /** Deliver `light` events. Default false. */
  lightEstimation?: boolean
  /** Default true. */
  autoFocus?: boolean
}

export interface HitResult {
  pose: Pose
  /** "plane": on a detected plane (`plane` = its id); "estimated": on a point of the feature
   *  cloud / an estimated plane. */
  type: "plane" | "estimated"
  plane?: f64
  /** Metres from the camera. */
  distance: f64
}

/** Both are ARScene's, always sent. Optional because a channel's params are (the generator's rule: a
 *  param a half cannot read has no one to reject to); a session opened without them rejects `start`
 *  with "failed". */
export interface ARParams {
  scene?: Scene3D
  /** The scene's camera entity: the session sets its matrix and the scene's projection each frame. */
  camera?: Entity
}

export interface AREvents {
  /** The tracking quality; the first event of a session. */
  tracking: { state: TrackingState, reason?: TrackingReason }
  /** A detected plane: added, moved / grown (throttled: a change over 1 cm, at most 10 per second),
   *  or gone (`mergedInto` = the plane that absorbed it, ARCore). `pose` = the plane's centre, its
   *  Y the normal; `extent` = [width, height] metres; `polygon` = the boundary as x,z pairs in the
   *  plane's space. */
  plane: { change: PlaneChange, id: f64, type: PlaneType, pose: Pose, extent: f64[], polygon: f64[], mergedInto?: f64 }
  /** An image target found, lost, or its size refined. While tracked its entity is driven: a rigid
   *  pose in metres, no scale — the image's centre, Y out of it, the image in XZ (X along its width,
   *  Z towards its bottom). `extent` = [width, height] metres, the framework's estimate (sent again
   *  when it changes by a millimetre, at most 10 per second); the last one when lost. A QR target's
   *  comes the same way (its frame: X along the symbol's top edge), `extent` = [size, size]. */
  image: { entity: Entity, tracked: boolean, extent: f64[] }
  /** An anchor made by `anchor()` lost or regained after a relocalization. */
  anchor: { entity: Entity, tracked: boolean }
  /** The estimated light (`lightEstimation`): lumens-ish ambient intensity (1000 = ARKit's
   *  neutral), colour temperature in kelvin; at most 10 per second. */
  light: { intensity: f64, temperature: f64 }
  /** The session failed and is over: "unavailable" (no ARKit / ARCore support, ARCore not
   *  installed and declined), "camera" (the camera could not be used), "failed". */
  error: { code: ARErrorCode, message: string }
}

export interface AR extends Service<"ar", ARParams, AREvents> {
  /** Start tracking; resolves at the first frame. A second start rejects "busy".
   *  @permission camera
   *  @rejects busy unavailable failed */
  start(options?: StartOptions): Promise<void>
  /** Stop tracking: the camera is released, the scene's projection and background cleared. Not
   *  running is not an error. */
  stop(): Promise<void>
  /** Replace the set of image targets of a RUNNING session without restarting it (the tracking, the
   *  planes and the anchors stay); an image no longer in the set stops driving its entity (its
   *  `image` event says `tracked: false` once if it was tracked). Before `start`, the images are
   *  `StartOptions.images`.
   *  @rejects notRunning failed */
  setImages(images: ImageTarget[]): Promise<void>
  /** The twin of `setImages` for QR codes: replace the set of QR targets of a RUNNING session
   *  without restarting it; a code no longer in the set stops driving its entity (`tracked: false`
   *  once if it was tracked). Before `start`, the codes are `StartOptions.codes`. A half that tracks
   *  no codes yet (the native ones) rejects "failed".
   *  @since 2
   *  @rejects notRunning failed */
  setCodes(codes: QRTarget[]): Promise<void>
  /** What is under a point of the scene's view — in its touches' space (a scene touch's `clientX` /
   *  `clientY`: the units of the gl facade's viewport) — nearest first. Empty when nothing is, or on
   *  a host without surfaces (the web).
   *  @rejects notRunning */
  hitTest(x: f64, y: f64, target?: HitTarget): Promise<HitResult[]>
  /** Pin `entity` to `pose`: the host's anchor drives its matrix from now on (and keeps it true
   *  as the world map refines). @rejects notRunning */
  anchor(entity: Entity, pose: Pose): Promise<void>
  /** Stop driving `entity` (its matrix stays where it was). */
  release(entity: Entity): Promise<void>
  /** The latest camera frame as a JPEG (the raw image, not the composite — that is
   *  `Scene.capture()`). @rejects notRunning failed */
  captureFrame(): Promise<File>
}
