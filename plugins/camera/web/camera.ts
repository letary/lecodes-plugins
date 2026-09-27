// camera on the web: the live preview is a <video> fed by getUserMedia; `takePhoto` draws the
// current frame to a canvas and hands the JPEG over as a File. The front preview is mirrored like a
// phone's; the captured frame is not.
//
// The channel is the contract's (../contract.d.ts): camera.gen.ts is generated from it, this file
// implements its CameraViewPlugin.

import { CameraViewError, registerCameraView, type CameraViewPlugin, type Facing, type PluginFile, type PluginHost } from "./camera.gen"

/** Register the half where the browser can serve it: getUserMedia exists only in secure contexts
 *  (https / localhost) — elsewhere the camera stays unsupported, like a shell without the plugin. */
export const register = (host: PluginHost): void => {
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") return

  registerCameraView(host, (params, events, doc): CameraViewPlugin => {
    const el = doc.createElement("div")
    el.style.cssText = "background:#000;overflow:hidden"
    const video = doc.createElement("video")
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    video.setAttribute("playsinline", "")
    video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover"
    el.appendChild(video)

    let facing: Facing = params.facingMode ?? "back"
    let stream: MediaStream | null = null
    let destroyed = false

    const stop = (): void => {
      if (stream) for (const track of stream.getTracks()) track.stop()
      stream = null
    }

    const start = async (): Promise<void> => {
      stop()
      let next: MediaStream
      try {
        next = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing === "front" ? "user" : "environment" },
          audio: false,
        })
      } catch (e) {
        events.error({ message: `CameraView: ${e instanceof Error ? e.message : String(e)}` })
        return
      }
      if (destroyed) {
        for (const track of next.getTracks()) track.stop()
        return
      }
      stream = next
      video.srcObject = next
      video.style.transform = facing === "front" ? "scaleX(-1)" : ""
      await video.play().catch(() => { /* autoplay policy — the muted preview still shows once playing is allowed */ })
    }

    let starting = start()

    return {
      el,
      async takePhoto(): Promise<PluginFile> {
        await starting
        if (!stream || video.videoWidth === 0) throw new CameraViewError("failed")
        const canvas = doc.createElement("canvas")
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new CameraViewError("failed")
        ctx.drawImage(video, 0, 0)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95))
        if (!blob) throw new CameraViewError("failed")
        return { data: await blob.arrayBuffer(), name: "image.jpg" }
      },
      async setFacingMode(mode: Facing): Promise<void> {
        facing = mode
        starting = start()
        await starting
      },
      destroy(): void {
        destroyed = true
        stop()
        video.srcObject = null
      },
    }
  })
}
