// MapView — a vector map (maplibre-native on iOS / Android, maplibre-gl in the browser) as a view
// the app pushes (`Router.push(map)`) or opens fullscreen (`map.open()`): a destination, never a
// child of a screen — the map in a screen's layout is `UIMapNode` (mapNode.ts). The style is a name, a URL, a bundled `asset()`, a read file or the style object (see
// MapStyle). Data goes in as named layers (`map.markers(name)`, `map.line(name)`) whose `set()`
// replaces their content; the camera is driven with `flyTo` / `fitPoints`; the user puck is fed by
// the app (`setUserLocation`) — the plugin never touches the location hardware.
//
// Hand-written over the generated wire because the public API is higher than the wire: the logic
// that makes it so is the map's, shared with the node `UIMapNode` (mapNode.ts) — mapState.ts: the
// style resolved to a url or to text (here once, at creation, as the View's params), GeoJSON from
// marker items, the calls queued until `ready`, the style's state re-applied after every style load.
// This file is the View's element over it.

import { ViewChannel, type NativeView } from "lecodes-sdk/plugin"
import { NAME, getCamera } from "./map.MapView.gen"
import type { MapEvents, MapParams } from "../contract"
import {
  MapState, resolveStyle,
  type CameraMove, type FitOptions, type LineLayer, type LineLayerOptions, type LngLat, type MapCamera, type MapOptions,
  type MapPaddingValues, type MapTap, type MarkerLayer, type MarkerLayerOptions, type UserLocationOptions,
} from "./mapState"

export {
  _toGeoJson,
  type CameraMove, type FitOptions, type LineLayer, type LineLayerOptions, type LngLat, type MapCamera, type MapOptions,
  type MapPaddingValues, type MapStyle, type MapStyleName, type MapTap, type MarkerItem, type MarkerLayer,
  type MarkerLayerOptions, type MarkerTap, type UserLocationOptions,
} from "./mapState"

export interface MapView extends NativeView {
  /** The style loaded and the map is interactive (queued calls have been replayed). */
  onReady(callback: () => void): this
  /** A tap that hit no feature of a managed layer. */
  onTap(callback: (tap: MapTap) => void): this
  /** The camera settled after a gesture or an animation. */
  onMove(callback: (camera: MapCamera) => void): this
  /** The map reported a problem — a style that wouldn't load, a source it couldn't reach. Never
   *  fatal; with no handler the message goes to `console.error`, so it is never silent. */
  onError(callback: (error: { message: string }) => void): this

  /** A named marker layer (one GeoJSON source). If the style already declares a source with this
   *  name, its layers are used as-is and only the data is pushed; otherwise the plugin creates the
   *  source and default marker layers (colored dot, `icon`, `title` label; clusters on request). */
  markers(name: string, options?: MarkerLayerOptions): MarkerLayer
  /** A named line layer (one GeoJSON source) — same style-first rule as `markers`. */
  line(name: string, options?: LineLayerOptions): LineLayer
  /** Raw escape hatch: replace the data of any GeoJSON source in the style. */
  setData(source: string, geojson: object): this

  flyTo(center: LngLat, options?: CameraMove): this
  jumpTo(center: LngLat, options?: CameraMove): this
  /** Fit the camera to these points (padding + the view padding respected). */
  fitPoints(points: LngLat[], options?: FitOptions): this
  /** Content inset: the part of the view covered by your UI (`"40%"` = of the view's size).
   *  Camera operations center inside the remaining area. */
  setPadding(padding: MapPaddingValues): this
  getCamera(): Promise<MapCamera>

  /** Move the user puck (the map draws it; the position comes from you — `Geolocation.watch`).
   *  `null` hides it. */
  setUserLocation(lngLat: LngLat | null, options?: UserLocationOptions): this
}

class MapViewElement extends ViewChannel<MapEvents> {
  /** @internal What the app put on the map, the queue until `ready`, the listeners. */
  readonly _map: MapState

  constructor(options: MapOptions = {}) {
    super("MapView", NAME, _styleParams(options))
    this._map = new MapState("MapView", (method, args) => this._call(method, args))
    this.on("ready", () => this._map.hostReady())
    this.on("tap", tap => this._map.hostTap(tap))
    this.on("moveEnd", camera => this._map.hostMove(camera))
    this.on("error", error => this._map.hostError(error))
  }

  onReady(callback: () => void): this { this._map.onReady(callback); return this }
  onTap(callback: (tap: MapTap) => void): this { this._map.onTap(callback); return this }
  onMove(callback: (camera: MapCamera) => void): this { this._map.onMove(callback); return this }
  onError(callback: (error: { message: string }) => void): this { this._map.onError(callback); return this }

  markers(name: string, options: MarkerLayerOptions = {}): MarkerLayer { return this._map.markers(name, options) }
  line(name: string, options: LineLayerOptions = {}): LineLayer { return this._map.line(name, options) }
  setData(source: string, geojson: object): this { this._map.setData(source, geojson); return this }

  flyTo(center: LngLat, options: CameraMove = {}): this { this._map.send("flyTo", [center, options]); return this }
  jumpTo(center: LngLat, options: CameraMove = {}): this { this._map.send("jumpTo", [center, options]); return this }
  fitPoints(points: LngLat[], options: FitOptions = {}): this { this._map.send("fitPoints", [points, options]); return this }
  setPadding(padding: MapPaddingValues): this { this._map.setPadding(padding); return this }
  getCamera(): Promise<MapCamera> { return getCamera(this) }

  setUserLocation(lngLat: LngLat | null, options: UserLocationOptions = {}): this {
    this._map.setUserLocation(lngLat, options)
    return this
  }

  /** @internal One fire-and-forget call through the queue (MapState.send). */
  _send(method: string, args: unknown[]): void { this._map.send(method as "flyTo", args as any) }
}

/** @internal `MapOptions` → the wire's params: the style resolved once, at creation (resolveStyle). */
export const _styleParams = (options: MapOptions = {}): MapParams => {
  const { style, ...rest } = options
  const resolved = resolveStyle(style, "MapView")
  return "url" in resolved ? { ...rest, style: resolved.url } : { ...rest, styleJson: resolved.json }
}

/**
 * Create a map view. `MapView.supported` reports whether this host registered a "map" view —
 * check it before offering the feature.
 */
// PURE IIFE so an app that never uses the map tree-shakes the whole plugin away.
export const MapView: {
  (options?: MapOptions): MapView
  /** Whether this host registered a "map" view. */
  readonly supported: boolean
} = /*#__PURE__*/ (() => {
  const factory = (options: MapOptions = {}): MapView => new MapViewElement(options) as unknown as MapView
  Object.defineProperty(factory, "supported", {
    get: (): boolean => ViewChannel.supports(NAME),
  })
  return factory as any
})()
