// camera — a live camera preview with still capture.
// The contract of the WIRE: what the app-facing `CameraView` (sdk/) and the halves (ios/, android/,
// web/) agree on. The generator reads this file; nothing else describes the channel.

import type { File, View } from "lecodes-sdk/plugin"

export type Facing = "front" | "back"

export interface CameraParams {
  /** Default "back". */
  facingMode?: Facing
}

export interface CameraEvents {
  /** The preview could not start or stopped (no camera, the stream was refused). */
  error: { message: string }
}

export interface CameraView extends View<"camera", CameraParams, CameraEvents> {
  /** Capture a still frame as a JPEG.
   *  @rejects failed */
  takePhoto(): Promise<File>
  /** Switch the camera while the preview is live. */
  setFacingMode(mode: Facing): Promise<void>
}
