// CameraView — the device camera (a live preview + still capture) as a view the app opens
// fullscreen (`await camera.open()`), pushes (`Router.push(camera)`) or embeds among a screen's
// children. `takePhoto()` returns a `File`: a texture source, a `FormData` value, a share.
//
// Hand-written over the generated wire for ONE reason: the permission is asked BEFORE the view is
// presented, while the current destination stays visible.

import { prepareCamera, type File, type NativeView, type PresentOptions } from "lecodes-sdk/plugin"
import { CameraViewBase, NAME } from "./camera.gen"
import type { Facing } from "../contract"

export type CameraFacing = Facing

export interface CameraView extends NativeView {
  /** Request the camera permission, then present the preview. The current destination stays
   *  visible until the camera is ready; rejects if the permission is denied, the host has no
   *  camera, or another navigation superseded this one. */
  open(options?: PresentOptions): Promise<void>
  /** Capture a still frame as an image `File` (host-encoded). */
  takePhoto(): Promise<File>
  /** Switch between the front and the back camera while the preview is live. */
  setFacingMode(facingMode: CameraFacing): Promise<void>
}

class CameraViewElement extends CameraViewBase {
  constructor(options: { facingMode?: CameraFacing } = {}) {
    super({ facingMode: options.facingMode ?? "back" })
  }

  /** @internal prepare-then-present (see Presentable._prepare). */
  _prepare(): Promise<void> { return prepareCamera(this) }

  override async open(options?: PresentOptions): Promise<void> {
    await this._prepare()
    super.open(options)
  }
}

/**
 * Create a camera view (default: the back camera). `CameraView.isSupported` reports whether this
 * host has the capability — check it before offering the feature.
 */
// PURE IIFE so an app that never uses the camera tree-shakes the whole plugin away.
export const CameraView: {
  (options?: { facingMode?: CameraFacing }): CameraView
  /** Whether this host registered a "camera" view. */
  readonly isSupported: boolean
} = /*#__PURE__*/ (() => {
  const factory = (options?: { facingMode?: CameraFacing }): CameraView =>
    new CameraViewElement(options) as unknown as CameraView
  Object.defineProperty(factory, "isSupported", {
    get: (): boolean => CameraViewBase.supports(NAME),
  })
  return factory as any
})()
