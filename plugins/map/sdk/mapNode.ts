// UIMapNode — the map as a NODE of a screen's layout (contract.d.ts: the host node "map"): a box
// sized by its styles like any element, drawn by the host's map view (maplibre-native on iOS and
// Android; on the web and in headless runs an empty box — `UIMapNode.supported` is false there).
// The fullscreen map with widgets over it stays `MapView` (map.ts).
//
// Hand-written over the generated element (map.UIMap.gen.ts, the class `UIMapNode`, imported as
// UIMapNodeBase) for the app's shape of it — the same as MapView's, through the same MapState
// (mapState.ts: the queue until `ready`, the style's state re-applied after every style load,
// GeoJSON from marker items, taps routed by layer), minus what only a View has (`open` / `close`,
// `onBack`, `widgets`). The params are LIVE props here: `center`, `zoom`, `bearing`, `pitch` move
// the camera (the props of one tick are one jump), `minZoom` / `maxZoom` / `rotate` / `tilt` set
// the map, and `mapStyle` (the MapStyle forms; `style` is the element's `.style()`) reloads the
// style when it is another one — the calls wait for its `ready` meanwhile.

import type { HostNodeElement, Json } from "lecodes-sdk/plugin"
import type { MapProps } from "../contract"
import { UIMapNode as UIMapNodeBase, type UIMapNodeStyle } from "./map.UIMap.gen"
import {
  MapState, resolveStyle,
  type CameraMove, type FitOptions, type LineLayer, type LineLayerOptions, type LngLat, type MapCamera, type MapOptions,
  type MapPaddingValues, type MapStyle, type MapTap, type MarkerLayer, type MarkerLayerOptions, type UserLocationOptions,
} from "./mapState"

export type { UIMapNodeStyle }

/**
 * The map as a node of the layout:
 *
 * ```ts
 * const map = UIMapNode({ center: [56.2415, 58.0105], zoom: 14 })
 *   .style({ height: 240, borderRadius: 16 })
 * map.markers("office").set([{ id: "office", lngLat: [56.2415, 58.0105], title: "Our office" }])
 * UIScreen(UIText("Visit us"), map, UIText("Lenina 1, Perm"))
 * ```
 *
 * A box like any element: size it with its styles (a `height`, or `flexGrow` in a column); it
 * measures nothing itself. Its corners follow `borderRadius` (the node clips: `overflow: "hidden"`
 * is its default style). Everything else is `MapView`'s: the layers, the camera calls, the events,
 * the queue until `onReady`. Branch on `UIMapNode.supported`: where it is `false` (the web, desktop,
 * headless runs, a build without the `map` plugin) the node is an empty box.
 */
export interface UIMapNode extends HostNodeElement<UIMapNodeStyle> {
  /** The style — a ready-made name, a URL, a bundled `asset()`, a read file or the style object
   *  ({@link MapStyle}). Writing another one reloads it: `onReady` fires again once it has loaded
   *  (the layers, their data, the padding and the user's dot come back on their own); the calls
   *  made meanwhile wait for it. Writing the same one does nothing. */
  mapStyle: MapStyle
  /** The camera's center, `[lng, lat]` — writing it moves the camera there at once (the zoom and
   *  the rest stay). Reads what was written last: the camera itself is `onMove` / `getCamera()`. */
  center: LngLat | undefined
  /** The zoom (default 12 with a center) — writing it zooms at once, the center kept. The props
   *  written in one tick (`center`, `zoom`, `bearing`, `pitch`) are one jump. */
  zoom: number | undefined
  minZoom: number | undefined
  maxZoom: number | undefined
  /** Degrees clockwise from north. */
  bearing: number | undefined
  /** Degrees from the vertical. */
  pitch: number | undefined
  /** The two-finger rotate gesture. Default true. */
  rotate: boolean | undefined
  /** The two-finger tilt gesture. Default false. */
  tilt: boolean | undefined

  /** The style loaded and the map is interactive (queued calls have been replayed); again after
   *  every style reload. */
  onReady(callback: () => void): this
  /** A tap that hit no feature of a managed layer. */
  onTap(callback: (tap: MapTap) => void): this
  /** The camera settled after a gesture or an animation. */
  onMove(callback: (camera: MapCamera) => void): this
  /** The map reported a problem — a style that wouldn't load, a source it couldn't reach. Never
   *  fatal; with no handler the message goes to `console.error`. */
  onError(callback: (error: { message: string }) => void): this

  /** A named marker layer — see `MapView.markers`. */
  markers(name: string, options?: MarkerLayerOptions): MarkerLayer
  /** A named line layer — see `MapView.line`. */
  line(name: string, options?: LineLayerOptions): LineLayer
  /** Raw escape hatch: replace the data of any GeoJSON source in the style. */
  setData(source: string, geojson: object): this

  flyTo(center: LngLat, options?: CameraMove): this
  jumpTo(center: LngLat, options?: CameraMove): this
  /** Fit the camera to these points (padding + the view padding respected). */
  fitPoints(points: LngLat[], options?: FitOptions): this
  /** Content inset: the part of the map covered by your UI (`"40%"` = of the node's size). Camera
   *  operations center inside the remaining area. */
  setPadding(padding: MapPaddingValues): this
  getCamera(): Promise<MapCamera>
  /** Move the user puck (the position comes from you — `Geolocation.watch`); `null` hides it. */
  setUserLocation(lngLat: LngLat | null, options?: UserLocationOptions): this
}

/** `MapOptions` → the first props: the style resolved here (resolveStyle). */
const styleProps = (style: MapStyle | undefined): Pick<MapProps, "styleUrl" | "styleJson"> => {
  const resolved = resolveStyle(style, "UIMapNode")
  return "url" in resolved ? { styleUrl: resolved.url } : { styleJson: resolved.json }
}

// The methods below replace the generated element's wire methods (Promise-returning) with the
// app's chainable ones: their return type is widened only for the signatures they replace — the
// public type is the interface above.
class MapNodeElement extends UIMapNodeBase {
  /** @internal What the app put on the map, the queue until `ready`, the listeners. */
  readonly _map: MapState
  private _appStyle: MapStyle

  constructor(options: MapOptions = {}) {
    const { style, ...rest } = options
    super({ ...styleProps(style), ...rest })
    this._appStyle = style ?? "liberty"
    this._map = new MapState("UIMapNode", (method, args) => this._call(method, args))
    this._on("ready", () => this._map.hostReady())
    this._on("tap", tap => this._map.hostTap(tap))
    this._on("moveEnd", camera => this._map.hostMove(camera))
    this._on("error", error => this._map.hostError(error))
    this.style({ overflow: "hidden" })
  }

  get mapStyle(): MapStyle { return this._appStyle }
  set mapStyle(style: MapStyle) {
    const next = styleProps(style)
    this._appStyle = style
    if (next.styleUrl === this.styleUrl && next.styleJson === this.styleJson) return
    this._map.styleChanged()
    this.styleUrl = next.styleUrl
    this.styleJson = next.styleJson
  }

  override onReady(callback: () => void): this { this._map.onReady(callback); return this }
  override onTap(callback: (tap: MapTap) => void): this { this._map.onTap(callback); return this }
  onMove(callback: (camera: MapCamera) => void): this { this._map.onMove(callback); return this }
  override onError(callback: (error: { message: string }) => void): this { this._map.onError(callback); return this }

  markers(name: string, options: MarkerLayerOptions = {}): MarkerLayer { return this._map.markers(name, options) }
  line(name: string, options: LineLayerOptions = {}): LineLayer { return this._map.line(name, options) }
  override setData(source: string, geojson: Json | object): any { this._map.setData(source, geojson as object); return this }

  override flyTo(center: LngLat, options: CameraMove = {}): any { this._map.send("flyTo", [center, options]); return this }
  override jumpTo(center: LngLat, options: CameraMove = {}): any { this._map.send("jumpTo", [center, options]); return this }
  override fitPoints(points: LngLat[], options: FitOptions = {}): any { this._map.send("fitPoints", [points, options]); return this }
  override setPadding(padding: MapPaddingValues): any { this._map.setPadding(padding); return this }
  override setUserLocation(lngLat: LngLat | null, options: UserLocationOptions = {}): any {
    this._map.setUserLocation(lngLat, options)
    return this
  }
}

/**
 * Create a map node — see {@link UIMapNode}. The options are `MapView`'s: the style (default
 * `"liberty"`), the first view (`center`, `zoom`, `bearing`, `pitch`), the zoom range and the
 * gestures. Default style `overflow: "hidden"`.
 */
// PURE IIFE so an app that never builds a map node tree-shakes it away.
export const UIMapNode: {
  (options?: MapOptions): UIMapNode
  /** Does this host draw the map node (iOS and Android with the `map` plugin)? Read at run time, on
   *  every access. */
  readonly supported: boolean
} = /*#__PURE__*/ (() => {
  const factory = (options: MapOptions = {}): UIMapNode => new MapNodeElement(options) as unknown as UIMapNode
  Object.defineProperty(factory, "supported", { get: (): boolean => UIMapNodeBase.supported })
  return factory as any
})()
