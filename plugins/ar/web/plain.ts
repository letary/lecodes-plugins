// ar on the web, the plain arm (./ar.ts picks it where there is no WebXR AR — Safari, a desktop
// browser, the web player): the camera's picture UNDER the scene (the host's background), the
// scene's camera turned as the device is (./orientation.ts — a Mahony filter over `devicemotion`,
// `deviceorientation` where there is no gyroscope). The device is a point that looks around: where it
// is is never known, so the camera stays at the world's origin and the world turns about the viewer;
// the heading the session begins with is −Z, as ARKit's and ARCore's. Nothing is found in the
// picture: no plane, no image, no light comes, `hitTest` answers [], `anchor` / `release` /
// `setImages` hold what is already true (the world's origin never moves).
//
// The picture is fitted to the scene's view — `host.gl.viewport(scene)`: the canvas the scene draws on
// (CSS px) and the display's turn — read every frame: a player inside a device frame is smaller than
// its page, and a turn or a resize re-makes the projection and the crop that frame.
//
// A page asks a browser for the camera and for the sensors:
//   - both need a page served over https (or localhost);
//   - Safari gives the sensors to a page that asks inside a tap. `ARScene.open()` from a tap's handler
//     is one; when it was not, the first tap on the page after that asks again.
// The camera's prompt is the browser's (getUserMedia): the contract's `@permission` is the native
// halves' gate.
//
// The channel is the contract's (../contract.d.ts): ar.gen.ts is generated from it, this file
// implements its ARPlugin for one session, driving the scene through the host's gl facade alone.

import { ARError, type ARParams, type AREvents, type ARPlugin, type HitResult, type ImageTarget, type PluginFile, type PluginGL, type StartOptions } from "./ar.gen"
import { Mahony, cameraTurn, coverUV, coveredFov, fromAngles, headingZero, matrixOf, multiply, perspective, upOf, type Quat } from "./orientation"

/** The angle of view along the longer side of a phone's main camera, degrees: a browser does not say
 *  what it is. */
const CAMERA_FOV = 68
const NEAR = 0.01
const FAR = 1000
const RAD = Math.PI / 180
/** How many animation frames a captureFrame() waits for the video to have a picture. */
const CAPTURE_WAIT_FRAMES = 30

type SensorsPermission = { requestPermission?: () => Promise<"granted" | "denied"> }

/** The plain arm of one session (`registerAR`'s make): the camera's video under the scene, the
 *  sensors turning its camera. */
export const createPlainArm = (gl: PluginGL, params: ARParams, events: AREvents): ARPlugin => {
  const scene = params.scene
  let generation = 0
  let running = false
  let starting = false
  let stream: MediaStream | null = null
  let video: HTMLVideoElement | null = null
  let cancelFrame: (() => void) | null = null
  /** What the projection and the crop were made for: the picture's size and the view's. */
  let projected = ""

  // the device's turn (device → earth): the filter's once a gyroscope speaks, else the browser's angles
  let filter = new Mahony()
  let motion = false
  let device: Quat | null = null
  let angles: [beta: number, gamma: number] | null = null
  let motionAt = 0
  let motionSince = 0
  /** The accelerometer's sign: +1 as the spec has it (up at rest), −1 where a browser reports the
   *  other way; 0 until told by the angles (or by half a second without them). */
  let sign = 0
  /** The turn about Y that makes the first heading −Z. */
  let zero: Quat | null = null
  let asking: (() => void) | null = null

  const onOrientation = (ev: DeviceOrientationEvent) => {
    // (a device with no sensors says nulls, or zeros for ever)
    if (ev.alpha === null || ev.beta === null || ev.gamma === null) return
    if (ev.alpha === 0 && ev.beta === 0 && ev.gamma === 0) return
    angles = [ev.beta, ev.gamma]
    device = fromAngles(ev.alpha, ev.beta, ev.gamma)
  }

  const onMotion = (ev: DeviceMotionEvent) => {
    const r = ev.rotationRate, a = ev.accelerationIncludingGravity
    if (!r || !a || r.alpha === null || r.beta === null || r.gamma === null || a.x === null || a.y === null || a.z === null) return
    const now = ev.timeStamp
    if (!motionSince) motionSince = now
    if (sign === 0) {
      // the up the accelerometer measures against the up the angles say
      if (angles) {
        const up = upOf(fromAngles(0, angles[0], angles[1]))
        const n = Math.hypot(a.x, a.y, a.z) || 1
        sign = (up[0] * a.x + up[1] * a.y + up[2] * a.z) / n < 0 ? -1 : 1
      } else if (now - motionSince > 500) sign = 1
      else return
    }
    const dt = motionAt ? Math.min(0.1, Math.max(0, (now - motionAt) / 1000)) : 0
    motionAt = now
    if (!motion) {
      motion = true
      if (device) filter.seed(device)
    }
    // rotationRate: alpha about the device's z, beta about x, gamma about y
    filter.update([r.beta * RAD, r.gamma * RAD, r.alpha * RAD], [a.x * sign, a.y * sign, a.z * sign], dt)
  }

  /** Before each frame: the projection the picture covers the scene's view with, the camera's turn.
   *  (The view has no size until the scene is presented: the frame after carries it.) */
  const frame = () => {
    if (!video || scene === undefined) return
    const view = gl.viewport(scene)
    const { width, height } = view
    const key = `${video.videoWidth}x${video.videoHeight}:${width}x${height}`
    if (key !== projected && video.videoWidth > 0 && width > 0 && height > 0) {
      projected = key
      const fov = coveredFov(video.videoWidth, video.videoHeight, width, height, CAMERA_FOV)
      gl.setProjection(scene, perspective(fov, width / height, NEAR, FAR), NEAR, FAR)
      gl.setBackground(scene, video, coverUV(video.videoWidth, video.videoHeight, width, height))
    }
    const turn = motion ? (filter.ready ? filter.q : null) : device
    if (!turn) return   // no sensors (a desktop): the camera stays as the app turned it
    const camera = cameraTurn(turn, view.rotation)
    zero ??= headingZero(camera)
    gl.setCameraMatrix(scene, matrixOf(multiply(zero, camera)))
  }

  const sensors = async (): Promise<boolean> => {
    const kinds = [
      (window as unknown as { DeviceMotionEvent?: SensorsPermission }).DeviceMotionEvent,
      (window as unknown as { DeviceOrientationEvent?: SensorsPermission }).DeviceOrientationEvent,
    ]
    if (!kinds[1]) return false
    let granted = true
    for (const kind of kinds) {
      if (typeof kind?.requestPermission !== "function") continue
      try { granted = (await kind.requestPermission()) === "granted" && granted } catch { granted = false }
    }
    return granted
  }
  const stopAsking = () => {
    if (asking) window.removeEventListener("pointerup", asking, true)
    asking = null
  }
  const askAtNextTap = () => {
    if (asking) return
    asking = () => {
      stopAsking()
      void sensors().then((granted) => { if (!granted) console.warn("[ar] the page was not given the device's sensors: the camera of the scene stays as the app turned it") })
    }
    window.addEventListener("pointerup", asking, true)
  }

  const end = () => {
    generation++
    running = false
    starting = false
    cancelFrame?.()
    cancelFrame = null
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
    if (video) {
      video.srcObject = null
      if (scene !== undefined) {
        gl.setBackground(scene, null)
        gl.clearProjection(scene)
      }
      video.remove()
    }
    video = null
    projected = ""
    stopAsking()
    window.removeEventListener("deviceorientation", onOrientation)
    window.removeEventListener("devicemotion", onMotion)
    filter = new Mahony()
    motion = false
    device = null
    angles = null
    motionAt = 0
    motionSince = 0
    sign = 0
    zero = null
  }

  return {
    async start(options?: StartOptions) {
      if (running || starting) throw new ARError("busy")
      if (scene === undefined || params.camera === undefined) {
        console.warn("[ar] start: the session has no scene or camera to drive (ARScene opens it with both)")
        throw new ARError("failed")
      }
      if (options?.mode === "images" || options?.images?.length) console.warn("[ar] the web finds no images in the camera's picture: their anchors are never tracked")
      starting = true
      const mine = ++generation
      // the sensors are asked for FIRST: inside the tap that opened the scene, where there was one
      const granted = sensors()
      let media: MediaStream
      try {
        media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } })
      } catch (e) {
        if (mine === generation) starting = false
        const name = e instanceof DOMException ? e.name : ""
        console.warn(`[ar] no camera: ${e instanceof Error ? e.message : e}`)
        throw new ARError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "unavailable" : "failed")
      }
      if (mine !== generation) { for (const track of media.getTracks()) track.stop(); throw new ARError("failed") }
      stream = media
      const v = document.createElement("video")
      v.muted = true
      v.playsInline = true
      v.autoplay = true
      v.srcObject = media
      video = v
      await new Promise<void>((resolve) => {
        if (v.readyState >= 2) return resolve()
        v.addEventListener("loadeddata", () => resolve(), { once: true })
      })
      await v.play().catch(() => {})
      if (mine !== generation) throw new ARError("failed")
      window.addEventListener("deviceorientation", onOrientation)
      window.addEventListener("devicemotion", onMotion)
      cancelFrame = gl.onFrame(frame)
      frame()
      starting = false
      running = true
      // the picture is there: tracking is what it will be (no world is mapped to lose)
      events.tracking({ state: "normal" })
      void granted.then((ok) => { if (!ok && mine === generation) askAtNextTap() })
    },

    stop() { end() },

    // nothing is found in the picture: a new set of images changes nothing (said as the start says it)
    setImages(images: ImageTarget[]) {
      if (!running) throw new ARError("notRunning")
      if (images.length) console.warn("[ar] the web finds no images in the camera's picture: their anchors are never tracked")
    },

    hitTest(): HitResult[] {
      if (!running) throw new ARError("notRunning")
      return []
    },

    anchor() {
      if (!running) throw new ARError("notRunning")
    },

    release() {},

    async captureFrame(): Promise<PluginFile> {
      const v = video
      if (!running || !v) throw new ARError("notRunning")
      // a running session's video can be without a picture for a moment (HAVE_CURRENT_DATA not
      // reached, no size: a track that restarts or changes its size): the capture waits for the
      // frames that follow, as the native halves wait for their camera image, rather than encode an
      // empty canvas — at most CAPTURE_WAIT_FRAMES; a stop meanwhile is "notRunning"
      const mine = generation
      for (let frames = 0; v.readyState < 2 || v.videoWidth === 0; frames++) {
        if (frames >= CAPTURE_WAIT_FRAMES) {
          console.warn(`[ar] captureFrame: the camera gave no picture in ${CAPTURE_WAIT_FRAMES} frames`)
          throw new ARError("failed")
        }
        await new Promise((resolve) => requestAnimationFrame(resolve))
        if (mine !== generation) throw new ARError("notRunning")
      }
      const canvas = document.createElement("canvas")
      canvas.width = v.videoWidth
      canvas.height = v.videoHeight
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new ARError("failed")
      ctx.drawImage(v, 0, 0)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9))
      if (!blob) throw new ARError("failed")
      return { data: await blob.arrayBuffer(), name: "frame.jpg" }
    },

    close() { end() },
  }
}
