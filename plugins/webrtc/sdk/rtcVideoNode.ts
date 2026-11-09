// UIRTCVideoNode — one video track as a NODE of a screen's layout (contract.d.ts: the host node
// "rtcVideo"): a box sized by its styles like any element, the picture drawn by the host's renderer
// (libwebrtc's on iOS and Android; on the web and in headless runs an empty box —
// `UIRTCVideoNode.supported` is false there). The fullscreen picture with widgets over it stays
// `RTCVideoView` (webrtc.ts, which re-exports this node).
//
// Hand-written over the generated element (webrtc.UIRTCVideo.gen.ts, the class `UIRTCVideoNode`,
// imported as UIRTCVideoNodeBase) for the app's shape of it: the app names a track by its object,
// the wire by its id. RTCVideoView holds no logic to share — its setters are calls, these are props —
// so this wrapper is thin:
//   - `track` (a MediaStreamTrack or null) writes the prop `trackId`; `objectFit`, `mirror` are the
//     props themselves (written at creation with their defaults, "cover" and false, so the getters
//     answer them); all three are LIVE, each write applied as it lands;
//   - `onResize` hears the picture's size: the first frame, and every change after (a rotation, the
//     other camera, a remote resolution change);
//   - default style `overflow: "hidden"` (the box clips the picture to its corners).

import type { HostNodeElement } from "lecodes-sdk/plugin"
import type { ObjectFit } from "../contract"
import { UIRTCVideoNode as UIRTCVideoNodeBase, type UIRTCVideoNodeStyle } from "./webrtc.UIRTCVideo.gen"
import type { MediaStreamTrack, RTCVideoViewOptions } from "./webrtc"

export type { UIRTCVideoNodeStyle }

/**
 * A video track as a node of the layout:
 *
 * ```ts
 * const mine = UIRTCVideoNode({ track: local.getVideoTracks()[0], mirror: true }).style({ width: 120, height: 160, borderRadius: 12 })
 * const theirs = UIRTCVideoNode().style({ flex: 1 })
 * pc.ontrack = (e) => { if (e.track.kind === "video") theirs.track = e.track }
 * UIScreen(theirs, mine)
 * ```
 *
 * A box like any element: size it with its styles (a `height`, or `flex: 1` in a column); it
 * measures nothing itself — `onResize` tells the picture's size, for an `aspectRatio` of yours. It
 * is black where there is no picture; its corners follow `borderRadius` (the node clips:
 * `overflow: "hidden"` is its default style). Branch on `UIRTCVideoNode.supported`: where it is
 * `false` (the web, desktop, headless runs, a build without the `webrtc` plugin) the node is an
 * empty box.
 */
export interface UIRTCVideoNode extends HostNodeElement<UIRTCVideoNodeStyle> {
  /** The track drawn, local or received; null = black. Writing it switches the picture. */
  track: MediaStreamTrack | null
  /** "cover" (the default) fills the box, cropped; "contain" shows the whole picture, black bars
   *  around it. */
  objectFit: ObjectFit
  /** Flip horizontally — the front camera's preview. Default false. */
  mirror: boolean
  /** The picture's size in pixels, as shown (a rotated camera's turned): the first frame, and every
   *  change after. */
  onResize(callback: (size: { width: number, height: number }) => void): this
}

class RTCVideoNodeElement extends UIRTCVideoNodeBase {
  private _track: MediaStreamTrack | null

  constructor(options: RTCVideoViewOptions) {
    super({ ...(options.track ? { trackId: options.track.id } : {}), objectFit: options.objectFit ?? "cover", mirror: options.mirror ?? false })
    this._track = options.track ?? null
    this.style({ overflow: "hidden" })
  }

  get track(): MediaStreamTrack | null { return this._track }
  set track(track: MediaStreamTrack | null) {
    if (this._track === track) return
    this._track = track
    this.trackId = track?.id
  }
}

/**
 * Create a video node — see {@link UIRTCVideoNode}. Default: no track (black), `objectFit: "cover"`,
 * no mirror; default style `overflow: "hidden"`.
 */
// PURE IIFE so an app that never shows a track in a screen tree-shakes it away.
export const UIRTCVideoNode: {
  (options?: RTCVideoViewOptions): UIRTCVideoNode
  /** Does this host draw the video node (iOS and Android with the `webrtc` plugin)? Read at run
   *  time, on every access. */
  readonly supported: boolean
} = /*#__PURE__*/ (() => {
  const factory = (options: RTCVideoViewOptions = {}): UIRTCVideoNode => new RTCVideoNodeElement(options) as unknown as UIRTCVideoNode
  Object.defineProperty(factory, "supported", { get: (): boolean => UIRTCVideoNodeBase.supported })
  return factory as any
})()
