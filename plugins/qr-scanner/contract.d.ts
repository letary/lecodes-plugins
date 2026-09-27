// qr-scanner — a camera view that decodes QR codes.
// A view with events only: the app opens / embeds it and listens.

import type { View } from "lecodes-sdk/plugin"

export interface QRScannerParams {}

export interface QRScannerEvents {
  /** One per decoded camera frame: the payload, or null for a frame with no readable code (it
   *  repeats while the user aims). The same code may be reported more than once. */
  scan: { data: string | null }
}

export interface QRScanner extends View<"qrScanner", QRScannerParams, QRScannerEvents> {}
