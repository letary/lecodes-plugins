// camera on the web: the live preview is a <video> fed by getUserMedia — ONE preview class
// (CameraPreview) behind the fullscreen View's instance and the host node's half (`UICameraNode`, Web
// Lite's `hostnode` feature), as on iOS and Android. `takePhoto` draws the current frame to a canvas
// and hands the JPEG over as a File. The front preview is mirrored like a phone's; the captured frame
// is not. The permission is the browser's own prompt, asked by getUserMedia when the preview starts;
// denied (or no camera), the preview sends `error` and stays black.
//
// The channel is the contract's (../contract.d.ts): camera.gen.ts is generated from it, this file
// implements its CameraViewPlugin and UICameraNodeHalf.

import {
  CameraViewError, registerCameraView, registerUICameraNode,
  type CameraViewPlugin, type Facing, type PluginFile, type PluginHost, type UICameraNodeHalf,
} from "./camera.gen"

/** The preview: a <video> filling `el`. An element taken out of the page pauses: shown again, it
 *  plays on. */
class CameraPreview {
  readonly el: HTMLElement
  private readonly video: HTMLVideoElement
  private readonly shown: IntersectionObserver | null
  private stream: MediaStream | null = null
  private destroyed = false
  /** The start in flight (or done): what a photo waits for. */
  private starting: Promise<void> = Promise.resolve()

  constructor(private readonly doc: Document, private readonly events: { error(payload: { message: string }): void }, private facing: Facing, private readonly name: string) {
    this.el = doc.createElement("div")
    this.el.style.background = "#000"
    this.el.style.overflow = "hidden"
    const video = this.video = doc.createElement("video")
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    video.setAttribute("playsinline", "")
    video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover"
    this.el.appendChild(video)
    this.shown = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && video.paused && video.srcObject) this.play()
    })
    this.shown?.observe(video)
  }

  private play(): Promise<void> {
    return this.video.play().catch(() => { /* autoplay policy — the muted preview still shows once playing is allowed */ })
  }

  private stop(): void {
    if (this.stream) for (const track of this.stream.getTracks()) track.stop()
    this.stream = null
  }

  /** (Re)start the preview on the current facing: the browser asks the permission. */
  start(): Promise<void> {
    this.starting = this.run()
    return this.starting
  }

  private async run(): Promise<void> {
    this.stop()
    let next: MediaStream
    try {
      next = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facing === "front" ? "user" : "environment" },
        audio: false,
      })
    } catch (e) {
      if (!this.destroyed) this.events.error({ message: `${this.name}: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    if (this.destroyed) {
      for (const track of next.getTracks()) track.stop()
      return
    }
    this.stream = next
    this.video.srcObject = next
    this.video.style.transform = this.facing === "front" ? "scaleX(-1)" : ""
    await this.play()
  }

  async setFacing(mode: Facing): Promise<void> {
    this.facing = mode
    await this.start()
  }

  async takePhoto(): Promise<PluginFile> {
    await this.starting
    const video = this.video
    if (!this.stream || video.videoWidth === 0) throw new CameraViewError("failed")
    const canvas = this.doc.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new CameraViewError("failed")
    ctx.drawImage(video, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95))
    if (!blob) throw new CameraViewError("failed")
    return { data: await blob.arrayBuffer(), name: "image.jpg" }
  }

  destroy(): void {
    this.destroyed = true
    this.shown?.disconnect()
    this.stop()
    this.video.srcObject = null
  }
}

/** Register the half where the browser can serve it: getUserMedia exists only in secure contexts
 *  (https / localhost) — elsewhere the camera stays unsupported, like a shell without the plugin. */
export const register = (host: PluginHost): void => {
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") return

  registerCameraView(host, (params, events, doc): CameraViewPlugin => {
    const preview = new CameraPreview(doc, events, params.facingMode ?? "back", "CameraView")
    void preview.start()
    return {
      el: preview.el,
      takePhoto: () => preview.takePhoto(),
      setFacingMode: (mode) => preview.setFacing(mode),
      destroy: () => preview.destroy(),
    }
  })

  // The node starts its preview at the end of the task it was made in, on the facing of its first
  // commit (as natively, one turn after the instance): a `facingMode` written by then is the camera
  // it opens; one written later switches it, as `setFacingMode` does.
  registerUICameraNode(host, (events, doc): UICameraNodeHalf => {
    const preview = new CameraPreview(doc, events, "back", "UICameraNode")
    let first: Facing | undefined
    let started = false
    // (a photo asked for before the start waits for it)
    const begun = new Promise<void>((resolve) => queueMicrotask(() => {
      started = true
      void preview.setFacing(first ?? "back")
      resolve()
    }))
    return {
      el: preview.el,
      takePhoto: async () => { await begun; return preview.takePhoto() },
      setFacingMode: (mode) => {
        if (!started) { first = mode; return }
        return preview.setFacing(mode ?? "back")
      },
      destroy: () => preview.destroy(),
    }
  })
}
