// UICameraNode — the device camera's live preview as a NODE of a screen's layout (contract.d.ts:
// the host node "camera"): a box sized by its styles like any element, filled by the preview
// (aspect-fill), with still capture. Drawn on iOS and Android; on the web and in headless runs an
// empty box — `UICameraNode.supported` is false there. The fullscreen camera with widgets over it
// stays `CameraView` (camera.ts).
//
// Hand-written over the generated element (camera.UICamera.gen.ts, the class `UICameraNode`,
// imported as UICameraNodeBase) for the app's shape of it — CameraView's minus what only a View has
// (`open` / `close`, `onBack`, `widgets`). camera.ts holds no logic to share: its one job, the
// permission asked before presenting, is the node half's own here (a node is no destination) — it
// asks when the preview is about to start and sends `error` when denied. So this wrapper is thin:
//   - `facingMode` is a LIVE prop (default "back"): a write switches the camera;
//   - `setFacingMode(mode)` writes the prop too, so the getter answers the camera shown, and
//     settles once the host has it (the call lands after the write: `nodeCall` keeps its place in
//     the commit);
//   - an `error` without a listener goes to `console.error` (a denied permission is never silent);
//   - default style `overflow: "hidden"` (the box clips the preview to its corners).

import type { File, HostNodeElement } from "lecodes-sdk/plugin"
import { UICameraNode as UICameraNodeBase, type UICameraNodeStyle } from "./camera.UICamera.gen"
import type { CameraFacing } from "./camera"

export type { UICameraNodeStyle }

/**
 * The camera's live preview as a node of the layout:
 *
 * ```ts
 * const camera = UICameraNode().style({ height: 300, borderRadius: 16 })
 * UIScreen(camera, UIButton(UIText("Shoot")).onClick(async () => show(await camera.takePhoto())))
 * ```
 *
 * A box like any element: size it with its styles (a `height`, or `flexGrow` in a column); it
 * measures nothing itself. Its corners follow `borderRadius` (the node clips: `overflow: "hidden"`
 * is its default style). The camera permission is asked when the preview starts (right after the
 * node is first shown); denied, `onError` hears it and the box stays empty. Branch on
 * `UICameraNode.supported`: where it is `false` (the web, desktop, headless runs, a build without
 * the `camera` plugin) the node is an empty box.
 */
export interface UICameraNode extends HostNodeElement<UICameraNodeStyle> {
  /** The camera shown — writing it switches the preview. Default "back". */
  facingMode: CameraFacing
  /** The preview could not start or stopped: the permission denied, no camera of that facing, the
   *  camera taken by another app. With no handler the message goes to `console.error`. */
  onError(callback: (error: { message: string }) => void): this
  /** Capture the current frame as an image `File` (a JPEG); rejects with "failed" when the camera
   *  has no frame to give (not started yet, the permission denied). */
  takePhoto(): Promise<File>
  /** Switch between the front and the back camera — the same as writing `facingMode`; settles
   *  once the host has it. */
  setFacingMode(facingMode: CameraFacing): Promise<void>
}

class CameraNodeElement extends UICameraNodeBase {
  private _errorHeard = false

  constructor(options: { facingMode?: CameraFacing } = {}) {
    super({ facingMode: options.facingMode ?? "back" })
    this._on("error", (error: { message: string }) => {
      if (!this._errorHeard) console.error(`UICameraNode: ${error.message}`)
    })
    this.style({ overflow: "hidden" })
  }

  override onError(callback: (error: { message: string }) => void): this {
    this._errorHeard = true
    return super.onError(callback)
  }

  override setFacingMode(mode: CameraFacing): Promise<void> {
    this.facingMode = mode
    return super.setFacingMode(mode)
  }
}

/**
 * Create a camera preview node — see {@link UICameraNode}. Default: the back camera; default style
 * `overflow: "hidden"`.
 */
// PURE IIFE so an app that never builds a camera node tree-shakes it away.
export const UICameraNode: {
  (options?: { facingMode?: CameraFacing }): UICameraNode
  /** Does this host draw the camera node (iOS and Android with the `camera` plugin)? Read at run
   *  time, on every access. */
  readonly supported: boolean
} = /*#__PURE__*/ (() => {
  const factory = (options: { facingMode?: CameraFacing } = {}): UICameraNode =>
    new CameraNodeElement(options) as unknown as UICameraNode
  Object.defineProperty(factory, "supported", { get: (): boolean => UICameraNodeBase.supported })
  return factory as any
})()
