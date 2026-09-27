// qr-scanner on the web: the preview is a <video> fed by getUserMedia (the back camera), the
// decoding is the browser's BarcodeDetector. `scan` fires on every change of what is read; its data
// is null when the code has left the frame for a while — the rule of the native halves.
//
// A browser without BarcodeDetector (Safari, Firefox today) registers nothing: `QRScanner.isSupported`
// is false there, like a shell without the plugin.
//
// The channel is the contract's (../contract.d.ts): qr-scanner.gen.ts is generated from it, this
// file implements its QRScannerPlugin.

import { registerQRScanner, type PluginHost, type QRScannerPlugin } from "./qr-scanner.gen"

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> }
type DetectorCtor = new (options: { formats: string[] }) => Detector

/** How often a frame is read. */
const INTERVAL_MS = 150
/** Reads with no code before the app hears `null`. */
const MISSES = 10

export const register = (host: PluginHost): void => {
  const Ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
  if (!Ctor) return
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") return

  registerQRScanner(host, (_params, events, doc): QRScannerPlugin => {
    const el = doc.createElement("div")
    el.style.cssText = "background:#000;overflow:hidden"
    const video = doc.createElement("video")
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    video.setAttribute("playsinline", "")
    video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover"
    el.appendChild(video)

    const detector = new Ctor({ formats: ["qr_code"] })
    const view = doc.defaultView ?? globalThis
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let destroyed = false
    let reading = false
    let last: string | null = null
    let misses = 0

    const read = async (): Promise<void> => {
      if (reading || destroyed || video.videoWidth === 0) return
      reading = true
      try {
        const found = (await detector.detect(video))[0]?.rawValue ?? null
        if (destroyed) return
        if (found !== null) {
          misses = 0
          if (found !== last) { last = found; events.scan({ data: found }) }
        } else if (last !== null && ++misses >= MISSES) {
          last = null
          events.scan({ data: null })
        }
      } catch { /* a frame that would not decode: the next one */ } finally {
        reading = false
      }
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then((next) => {
      if (destroyed) {
        for (const track of next.getTracks()) track.stop()
        return
      }
      stream = next
      video.srcObject = next
      void video.play().catch(() => { /* autoplay policy — the muted preview still shows once playing is allowed */ })
      timer = view.setInterval(() => { void read() }, INTERVAL_MS)
    }, () => { /* no camera, or refused: the preview stays black — the contract has no event for it */ })

    return {
      el,
      destroy(): void {
        destroyed = true
        if (timer !== null) view.clearInterval(timer)
        if (stream) for (const track of stream.getTracks()) track.stop()
        stream = null
        video.srcObject = null
      },
    }
  })
}
