// ar on the web: two arms, one chosen at each start.
//   - WebXR (./webxr.ts): an `immersive-ar` session — Chrome on Android, over ARCore — where the
//     browser has one AND the host's engine draws into it (`host.gl.presentXR`: Web Lite's). SLAM:
//     the position too, hit tests, anchors, the light, the camera's picture for captureFrame, the
//     QR codes found in it (./qrAnchor.ts). The camera is the browser's, the scene drawn into the
//     session's layer, the page's UI its DOM overlay.
//   - plain (./plain.ts): everywhere else (Safari, a desktop browser, the web player): the camera's
//     picture under the scene (the host's background), the scene's camera turned by the device's
//     sensors (./orientation.ts); the device never moves, nothing is found.
// Both drive the scene through `host.gl` alone; the world is the contract's (the session's start =
// the origin, −Z its heading, Y up, metres).
//
// The choice is made when `start` comes (inside the tap that opened the scene: the arm asks for its
// session, its camera and its sensors in it) and holds until `stop` / `close`: every call goes to
// the arm that started. Before a start (and after a stop) there is no arm: the calls that need a
// running session reject "notRunning".
//
// `resources` = the manifest's `web.resources` (the QR detector's wasm, ./qrAnchor.ts), handed by the
// host's build as a function: nothing of it is fetched until the WebXR arm is given a code.
//
// The channel is the contract's (../contract.d.ts): ar.gen.ts is generated from it, this file
// registers its service.

import { ARError, registerAR, type ARPlugin, type PluginHost } from "./ar.gen"
import { createPlainArm } from "./plain"
import type { ARWebResources } from "./qrAnchor"
import { createWebXRArm, webxrSupported, type XRGL } from "./webxr"

export const register = (host: PluginHost, resources?: () => Promise<ARWebResources>): void => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return
  // taken while registering: a half that drives the 3D engine says so (a host makes its canvas for a
  // background then)
  const gl = host.gl as XRGL

  registerAR(host, (params, events): ARPlugin => {
    // made by the first start that takes them; each keeps its own session's state
    let plain: ARPlugin | null = null
    let webxr: ARPlugin | null = null
    /** The arm that started: every call goes to it until stop / close. */
    let arm: ARPlugin | null = null
    let choosing = false
    /** Moves with each stop / close: a start still choosing then is over. */
    let generation = 0

    const running = (): ARPlugin => {
      if (!arm) throw new ARError("notRunning")
      return arm
    }
    const leave = () => {
      generation++
      const a = arm
      arm = null
      return a
    }

    return {
      async start(options) {
        if (choosing) throw new ARError("busy")
        if (arm) return arm.start(options)   // (running: it says "busy")
        choosing = true
        const mine = generation
        let chosen: ARPlugin
        try {
          chosen = await webxrSupported(gl)
            ? (webxr ??= createWebXRArm(gl, params, events, resources))
            : (plain ??= createPlainArm(gl, params, events))
        } finally {
          choosing = false
        }
        if (mine !== generation) throw new ARError("failed")
        arm = chosen
        try {
          await chosen.start(options)
        } catch (e) {
          if (arm === chosen) arm = null
          throw e
        }
      },
      stop() { return leave()?.stop() },
      setImages(images) { return running().setImages(images) },
      setCodes(codes) { return running().setCodes(codes) },
      hitTest(x, y, target) { return running().hitTest(x, y, target) },
      anchor(entity, pose) { return running().anchor(entity, pose) },
      release(entity) { return arm?.release(entity) },
      captureFrame() { return running().captureFrame() },
      close() { leave()?.close?.() },
    }
  })
}
