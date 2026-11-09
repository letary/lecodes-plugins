// camera — a live camera preview with still capture, on two surfaces with one set of methods
// (CameraMethods): the fullscreen VIEW "camera" (`CameraView`: its own layer, `Router.push`, widgets
// over it) and the HOST NODE "camera" (`UICameraNode`: a box in a screen's layout,
// docs/plans/host-node-plan.md in core). On iOS and Android both are one preview class under two
// thin instances; the web half is the View's only (a host node has none: an empty box there).
// The contract of the WIRE: what the app-facing wrappers (sdk/) and the halves (ios/, android/,
// web/) agree on. The generator reads this file; nothing else describes the channel.
//
// The camera permission: the View's wrapper asks for it before the View is presented (the current
// destination stays on screen meanwhile); the node's half asks for it itself, before its preview
// starts, and sends `error` when it is denied.

import type { File, UIHostNode, View } from "lecodes-sdk/plugin"

export type Facing = "front" | "back"

export interface CameraParams {
  /** Default "back". */
  facingMode?: Facing
}

/** The node's props: the View's params, LIVE — a write switches the camera, as `setFacingMode`. */
export interface CameraProps {
  /** Default "back". */
  facingMode?: Facing
}

export interface CameraEvents {
  /** The preview could not start or stopped (no camera, the stream was refused). */
  error: { message: string }
}

/** The methods of both surfaces: the View's and the node's, one implementation per platform. */
export interface CameraMethods {
  /** Capture a still frame as a JPEG.
   *  @rejects failed */
  takePhoto(): Promise<File>
  /** Switch the camera while the preview is live. */
  setFacingMode(mode: Facing): Promise<void>
}

export interface CameraView extends View<"camera", CameraParams, CameraEvents>, CameraMethods {}

/** The camera as a node of the layout: a box in a screen, sized by its styles, filled by the live
 *  preview (aspect-fill); the holder paints the box (radius, border, shadow) over it. The half asks
 *  for the camera permission before the preview starts; denied, the node sends `error`. */
export interface UICamera extends UIHostNode<"camera", CameraProps, CameraEvents>, CameraMethods {}
