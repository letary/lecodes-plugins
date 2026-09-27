// QRScanner — the host's camera QR scanner as a view the app opens fullscreen
// (`await scanner.open()`), pushes (`Router.push(scanner)`) or embeds as a live preview.
//
// Hand-written over the generated wire for two things: `onScan` hands over the decoded string, not
// the event's payload, and the permission is asked BEFORE the view is presented.

import { prepareCamera, type NativeView, type PresentOptions } from "lecodes-sdk/plugin"
import { NAME, QRScannerBase } from "./qr-scanner.gen"

export interface QRScanner extends NativeView {
  /** Fires per decoded camera frame: the decoded string, or `null` for a frame with no readable
   *  code (expect those repeatedly while the user aims). The same code can be reported more than
   *  once — `close()` or debounce once you have what you need. */
  onScan(callback: (data: string | null) => void): this
  /** Request the camera permission, then present the scanner. The current destination (and its
   *  loading state) stays visible until the scanner is ready; rejects if the camera is denied,
   *  the host can't scan, or another navigation superseded this one. */
  open(options?: PresentOptions): Promise<void>
}

class QRScannerElement extends QRScannerBase {
  onScan(callback: (data: string | null) => void): this {
    return this.on("scan", payload => callback(payload?.data ?? null))
  }

  /** @internal prepare-then-present (see Presentable._prepare). */
  _prepare(): Promise<void> { return prepareCamera(this) }

  override async open(options?: PresentOptions): Promise<void> {
    await this._prepare()
    super.open(options)
  }
}

/**
 * Create a QR scanner view. `QRScanner.isSupported` reports whether this host can scan at all —
 * check it before offering the feature.
 */
// PURE IIFE so an app that never scans tree-shakes the whole plugin away.
export const QRScanner: {
  (): QRScanner
  /** Whether this host registered a "qrScanner" view. */
  readonly isSupported: boolean
} = /*#__PURE__*/ (() => {
  const factory = (): QRScanner => new QRScannerElement() as unknown as QRScanner
  Object.defineProperty(factory, "isSupported", {
    get: (): boolean => QRScannerBase.supports(NAME),
  })
  return factory as any
})()
