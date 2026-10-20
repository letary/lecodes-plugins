// ar on the web, the QR detector's worker: qr-anchor's wasm (./qr-anchor/) off the main thread. The
// manifest's resource `qrAnchorWorker` (`web.resources`, `as: "worker-url"`: the host's bundler
// builds this file as a module worker of its own, the wasm an asset beside it); ./qrAnchor.ts makes
// it with the session's first code and ends it with the session.
//
// Two detector sessions of the same targets, one per phase of the tracker (the wasm takes its
// parameters once, `new QrAnchor(config)`): SEEKING pictures (smaller, a full detection each) and
// HOLDING ones (larger, a window around the held codes, the half-resolution search first). Each
// keeps its own history (the re-acquire gate, the last quad as the next window) in its own
// pictures' pixels.
//
// The protocol (one message at a time, in order — a frame waits for the module's load):
//   → init { config: { seeking, holding }, targets }    the module loaded, both sessions made
//   → targets { targets }                               both sessions' targets replaced
//   → frame { seq, phase, gray, width, height, p0 p5 p8 p9, hints }
//        gray = the picture's bytes (an ArrayBuffer, TRANSFERRED: the main thread keeps no copy),
//        p* = the view's projection entries (process_gl), hints = [target, x0, y0, x1, y1] windows
//        in this picture's pixels
//   ← ready { version, ms }                             after init
//   ← result { seq, observations, processMs }           observations = 28 f64 each (layout 1,
//                                                       TRANSFERRED), processMs = the detector's
//   ← failed { message }                                the module or a session failed: nothing more
// Imports nothing of the page (no DOM): `self` is read as the shape it is used as.

import init, { QrAnchor, output_layout_version, output_stride, version } from "./qr-anchor/qr_anchor_wasm.js"

/** The detector's parameters (qr-anchor's `Params`, its README), merged over its defaults. */
export type QRWorkerParams = Record<string, number | boolean>
export type QRWorkerTarget = { text: string, size: number }
export type QRWorkerPhase = "seeking" | "holding"
/** A detection window for the next frame only: the target's index, columns x0..x1, rows y0..y1. */
export type QRWorkerHint = [target: number, x0: number, y0: number, x1: number, y1: number]
export type ToQRWorker =
  | { type: "init", config: Record<QRWorkerPhase, QRWorkerParams>, targets: QRWorkerTarget[] }
  | { type: "targets", targets: QRWorkerTarget[] }
  | { type: "frame", seq: number, phase: QRWorkerPhase, gray: ArrayBuffer, width: number, height: number, p0: number, p5: number, p8: number, p9: number, hints: QRWorkerHint[] }
export type FromQRWorker =
  | { type: "ready", version: string, ms: number }
  | { type: "result", seq: number, observations: Float64Array, processMs: number }
  | { type: "failed", message: string }

/** The output this worker reads (qr-anchor's layout 1): 28 f64 per observation. */
const LAYOUT = 1
const STRIDE = 28

type Scope = {
  onmessage: ((event: { data: ToQRWorker }) => void) | null
  postMessage(message: FromQRWorker, transfer?: Transferable[]): void
}
const scope = self as unknown as Scope

let memory: WebAssembly.Memory | null = null
const sessions: Partial<Record<QRWorkerPhase, QrAnchor>> = {}
let broken = false

const setTargets = (targets: QRWorkerTarget[]) => {
  const json = JSON.stringify(targets)
  sessions.seeking?.set_targets(json)
  sessions.holding?.set_targets(json)
}

const handle = async (message: ToQRWorker): Promise<void> => {
  if (message.type === "init") {
    const t0 = performance.now()
    const loaded = await init({ module_or_path: new URL("./qr-anchor/qr_anchor_wasm_bg.wasm", import.meta.url) })
    if (output_layout_version() !== LAYOUT || output_stride() !== STRIDE) {
      throw new Error(`its output is layout ${output_layout_version()} × ${output_stride()}, this worker reads ${LAYOUT} × ${STRIDE}`)
    }
    memory = loaded.memory
    sessions.seeking = new QrAnchor(JSON.stringify(message.config.seeking))
    sessions.holding = new QrAnchor(JSON.stringify(message.config.holding))
    setTargets(message.targets)
    scope.postMessage({ type: "ready", version: version(), ms: performance.now() - t0 })
    return
  }
  if (message.type === "targets") {
    setTargets(message.targets)
    return
  }
  const d = sessions[message.phase]
  if (!d || !memory) throw new Error("a frame before the detector was made")
  const { seq, width, height } = message
  const t0 = performance.now()
  const at = d.frame_ptr(width, height)
  let n = 0
  if (at) {
    // (a view of the memory each time: it may have grown)
    new Uint8Array(memory.buffer, at, width * height).set(new Uint8Array(message.gray, 0, width * height))
    for (const [target, x0, y0, x1, y1] of message.hints) d.set_hint(target, x0, y0, x1, y1)
    n = d.process_gl(message.p0, message.p5, message.p8, message.p9)
  }
  // copied out of the wasm's memory into a buffer of its own, handed over
  const observations = n > 0 ? new Float64Array(memory.buffer, d.output_ptr(), d.output_len()).slice() : new Float64Array(0)
  scope.postMessage({ type: "result", seq, observations, processMs: performance.now() - t0 }, [observations.buffer])
}

let queue = Promise.resolve()
scope.onmessage = (event) => {
  const message = event.data
  queue = queue.then(() => {
    if (broken) return
    return handle(message).catch((e: unknown) => {
      broken = true
      scope.postMessage({ type: "failed", message: e instanceof Error ? e.message : String(e) })
    })
  })
}
