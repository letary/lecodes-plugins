// MapView — a vector map (maplibre-native on iOS / Android, maplibre-gl in the browser) as a view
// the app pushes (`Router.push(map)`), opens fullscreen (`map.open()`) or embeds among a screen's
// children. The style is a name, a URL, a bundled `asset()`, a read file or the style object (see
// MapStyle). Data goes in as named layers (`map.markers(name)`, `map.line(name)`) whose `set()`
// replaces their content; the camera is driven with `flyTo` / `fitPoints`; the user puck is fed by
// the app (`setUserLocation`) — the plugin never touches the location hardware.
//
// Hand-written over the generated wire because the public API is higher than the wire:
//   - a style is resolved to a url or to text HERE, once, at creation;
//   - marker items and coordinate lists become GeoJSON here;
//   - the native map exists only once presented and its style loaded (`ready`): calls issued before
//     that are queued and replayed in order, so an app builds the map declaratively and pushes it
//     later without a ready-dance of its own;
//   - what lives in the STYLE (layers, data, the padding, the user puck) is kept and re-applied
//     after every style load.

import { ViewChannel, bufferText, type FetchResponse, type Json, type NativeView } from "lecodes-sdk/plugin"
import { NAME, ensureLayer, fitPoints, flyTo, getCamera, jumpTo, setData, setPadding, setUserLocation } from "./map.gen"
import type {
  LngLat, MapCamera, MapCameraMove, MapEvents, MapFitOptions, MapLayerKind, MapPadding, MapParams,
  MapTap as WireTap, MapUserLocationOptions,
} from "../contract"

export type { LngLat, MapCamera }
export type CameraMove = MapCameraMove
export type FitOptions = MapFitOptions
export type MapPaddingValues = MapPadding
export type UserLocationOptions = MapUserLocationOptions

/** The ready-made styles a map falls back on — [OpenFreeMap](https://openfreemap.org): OSM data,
 *  no key, no registration, no request limits, commercial use allowed, and the whole stack is
 *  open-source if you'd rather self-host. `liberty` is the default. Credit them (and OSM) in your
 *  app: "© OpenFreeMap © OpenMapTiles, data from OpenStreetMap". A public free instance is a
 *  donation-funded service with no SLA — for a product with real traffic, run your own tiles and
 *  pass that style's URL instead. */
export type MapStyleName = "liberty" | "bright" | "positron" | "dark" | "fiord"

const NAMED_STYLES: Record<string, string> = {
  liberty: "https://tiles.openfreemap.org/styles/liberty",
  bright: "https://tiles.openfreemap.org/styles/bright",
  positron: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
  fiord: "https://tiles.openfreemap.org/styles/fiord",
}

/**
 * Where the map's style comes from:
 *
 * - a **name** — `"liberty"` (the default), `"positron"`, … see {@link MapStyleName}: a ready-made
 *   style on a free public tile server, so `MapView()` alone already draws a world map;
 * - a **URL** — `"https://tiles.example.com/styles/city/style.json"`, the map fetches it;
 * - a **bundled style** — `asset("./map/style.json")`: the file ships inside the app and the
 *   wrapper hands its text to the map, so the style itself needs no server (tiles, sprites and
 *   glyphs are still fetched from whatever urls it names);
 * - an **already-read file** — a `FetchResponse` from `fetchLocal("style.json")` or
 *   `await fetch(url)` (a style downloaded once and cached in `files`);
 * - the **style object** itself — the natural way to substitute a tile-server address at runtime:
 *   `{ ...style, sources: { openmaptiles: { type: "vector", url: `${server}/data/v3.json` } } }`.
 *
 * Whichever form: **every url INSIDE the style (`sources[].url`, `sprite`, `glyphs`) must be
 * absolute.** maplibre-native, unlike maplibre-gl-js, resolves no relative ones — a style with
 * them loads to an empty basemap (your layers still draw). A tileserver-gl instance emits
 * relative urls until its `publicUrl` is configured.
 */
// `string & {}` keeps the named suggestions in the editor while still accepting any URL.
export type MapStyle = MapStyleName | (string & {}) | FetchResponse | object

export interface MapOptions extends Omit<MapParams, "style" | "styleJson"> {
  /** The MapLibre style: a ready-made name (`"liberty"` — the default, `"positron"`, …), a URL,
   *  a style bundled with the app (`asset("./style.json")`), an already-read file
   *  (`fetchLocal("style.json")`, `await fetch(url)`) or the style object itself — see
   *  {@link MapStyle}. */
  style?: MapStyle
}

/** A tap on the map itself — not on a feature of a managed layer. */
export interface MapTap {
  lngLat: LngLat
  /** View-space point, px. */
  point: [number, number]
}

/** One marker. `id` comes back in `onTap`; `icon` names an image of the style's sprite; `color` /
 *  `title` feed the default layers; extra keys become feature properties. */
export interface MarkerItem {
  id: string | number
  lngLat: LngLat
  icon?: string
  color?: string
  title?: string
  [property: string]: any
}

export interface MarkerTap {
  id: string | number
  lngLat: LngLat
  /** Every property of the tapped feature (the item's keys, `id` and `lngLat` excluded). */
  properties: Record<string, any>
}

export interface MarkerLayerOptions {
  /** Group nearby markers into clusters (a cluster tap zooms in). Default false. */
  cluster?: boolean
  /** Cluster radius, px (default 50). */
  clusterRadius?: number
  /** Zoom at which clusters stop forming (default: maxZoom − 1). */
  clusterMaxZoom?: number
}

export interface LineLayerOptions {
  color?: string
  /** Px (default 4). */
  width?: number
  /** 0–1 (default 1). */
  opacity?: number
}

export interface MarkerLayer {
  readonly name: string
  /** Replace the layer's markers. */
  set(items: MarkerItem[]): this
  clear(): this
  /** A marker (or any feature of this layer's source) was tapped. */
  onTap(callback: (marker: MarkerTap) => void): this
}

export interface LineLayer {
  readonly name: string
  /** Replace the line with these vertices. */
  set(coordinates: LngLat[]): this
  clear(): this
}

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

/** The wire's calls the wrapper sends without waiting for an answer, by name: what a queue entry
 *  replays. Every one takes the view first. */
const SEND = { ensureLayer, setData, flyTo, jumpTo, fitPoints, setPadding, setUserLocation }
type Send = typeof SEND
type SendArgs<M extends keyof Send> = Send[M] extends (view: any, ...args: infer A) => any ? A : never

type Queued = { method: string, args: any[] }
type LayerSpec = { kind: MapLayerKind, options: object }

/** Methods whose effect lives in the STYLE, not in the view: a style (re)load wipes them, so the
 *  wrapper keeps their last value and re-applies it on every `ready` instead of replaying them
 *  from the queue. Camera calls are not here — the camera survives a style reload. */
const STATEFUL = ["ensureLayer", "setData", "setPadding", "setUserLocation"]

class MapViewElement extends ViewChannel<MapEvents> {
  private _ready = false
  private _queue: Queued[] = []
  private readonly _layers = new Map<string, MapLayerHandle>()
  /** Style-lifetime state, re-applied on every `ready` (see STATEFUL). */
  private readonly _specs = new Map<string, LayerSpec>()
  private readonly _data = new Map<string, object>()
  private _padding?: MapPaddingValues
  private _user?: SendArgs<"setUserLocation">
  private readonly _readyCallbacks: (() => void)[] = []
  private readonly _tapCallbacks: ((tap: MapTap) => void)[] = []
  private readonly _moveCallbacks: ((camera: MapCamera) => void)[] = []
  private readonly _errorCallbacks: ((error: { message: string }) => void)[] = []

  constructor(options: MapOptions = {}) {
    super("MapView", NAME, _styleParams(options))
    this.on("ready", () => this._onReady())
    this.on("tap", tap => this._onTap(tap))
    this.on("moveEnd", camera => { for (const cb of [...this._moveCallbacks]) cb(camera) })
    this.on("error", error => this._onError(error))
  }

  onReady(callback: () => void): this { this._readyCallbacks.push(callback); return this }
  onTap(callback: (tap: MapTap) => void): this { this._tapCallbacks.push(callback); return this }
  onMove(callback: (camera: MapCamera) => void): this { this._moveCallbacks.push(callback); return this }
  onError(callback: (error: { message: string }) => void): this { this._errorCallbacks.push(callback); return this }

  markers(name: string, options: MarkerLayerOptions = {}): MarkerLayer {
    return this._layer(name, "markers", options) as MarkerLayer
  }
  line(name: string, options: LineLayerOptions = {}): LineLayer {
    return this._layer(name, "line", options) as LineLayer
  }
  setData(source: string, geojson: object): this {
    this._data.set(source, geojson)
    this._send("setData", [source, geojson as Json])
    return this
  }

  flyTo(center: LngLat, options: CameraMove = {}): this { this._send("flyTo", [center, options]); return this }
  jumpTo(center: LngLat, options: CameraMove = {}): this { this._send("jumpTo", [center, options]); return this }
  fitPoints(points: LngLat[], options: FitOptions = {}): this { this._send("fitPoints", [points, options]); return this }
  setPadding(padding: MapPaddingValues): this { this._padding = padding; this._send("setPadding", [padding]); return this }
  getCamera(): Promise<MapCamera> { return getCamera(this) }

  setUserLocation(lngLat: LngLat | null, options: UserLocationOptions = {}): this {
    this._user = [lngLat, options]
    this._send("setUserLocation", this._user)
    return this
  }

  /** @internal queue until `ready`, then straight through. Rejections are logged, never thrown:
   *  a fire-and-forget camera / data call has no caller to reject to. */
  _send<M extends keyof Send>(method: M, args: SendArgs<M>): void {
    if (!this._ready) { this._queue.push({ method, args }); return }
    const call: (view: this, ...args: any[]) => Promise<void> = SEND[method] ?? ((view, ...rest) => view._call(method, rest))
    call(this, ...args).catch((e: Error) => console.error(`MapView.${method}: ${e.message}`))
  }

  private _layer(name: string, kind: MapLayerKind, options: object): MapLayerHandle {
    let layer = this._layers.get(name)
    if (!layer) {
      layer = new MapLayerHandle(this, name)
      this._layers.set(name, layer)
      this._specs.set(name, { kind, options })
      this._send("ensureLayer", [name, kind, options])
    }
    return layer
  }

  /** A style load — the first one or a reload — starts from a style that knows nothing about the
   *  app's layers, so re-apply them all, then whatever else waited in the queue. Without this a
   *  second `ready` (a host that loads its default style before the app's, a style swap) leaves a
   *  correct-looking map with no data on it. */
  private _onReady(): void {
    this._ready = true
    const queue = this._queue
    this._queue = []
    for (const [name, spec] of this._specs) this._send("ensureLayer", [name, spec.kind, spec.options])
    for (const [source, geojson] of this._data) this._send("setData", [source, geojson as Json])
    if (this._padding) this._send("setPadding", [this._padding])
    if (this._user) this._send("setUserLocation", this._user)
    for (const q of queue) if (STATEFUL.indexOf(q.method) < 0) this._send(q.method as keyof Send, q.args as any)
    for (const cb of [...this._readyCallbacks]) cb()
  }

  private _onError(error: { message: string }): void {
    // Unhandled is not unheard: a style the host couldn't load is exactly the failure that looks
    // like "the map is blank and nothing happened".
    if (this._errorCallbacks.length === 0) { console.error(`MapView: ${error?.message ?? "unknown error"}`); return }
    for (const cb of [...this._errorCallbacks]) cb(error)
  }

  private _onTap(tap: WireTap): void {
    const feature = tap?.feature
    const layer = feature ? this._layers.get(feature.source) : undefined
    if (feature && layer) {
      layer._tap({ id: feature.id as string | number, lngLat: tap.lngLat, properties: feature.properties ?? {} })
      return
    }
    for (const cb of [...this._tapCallbacks]) cb({ lngLat: tap.lngLat, point: tap.point })
  }
}

/** One named GeoJSON source on the map — the object behind both `MarkerLayer` and `LineLayer`. */
class MapLayerHandle {
  private readonly _tapCallbacks: ((marker: MarkerTap) => void)[] = []
  private readonly _map: MapViewElement
  readonly name: string

  constructor(map: MapViewElement, name: string) {
    this._map = map
    this.name = name
  }

  set(items: MarkerItem[] | LngLat[]): this {
    this._map.setData(this.name, _toGeoJson(items))
    return this
  }
  clear(): this {
    this._map.setData(this.name, { type: "FeatureCollection", features: [] })
    return this
  }
  onTap(callback: (marker: MarkerTap) => void): this {
    this._tapCallbacks.push(callback)
    return this
  }
  /** @internal */
  _tap(marker: MarkerTap): void {
    for (const cb of [...this._tapCallbacks]) cb(marker)
  }
}

/** @internal `MapOptions` → the wire's params. A style URL stays a url the map fetches itself; every
 *  other form is read HERE and crosses as `styleJson` text — one string, once, at creation. A
 *  bundled `asset()` is `"id:N"` in shell compiles (the host already holds the bytes) and a plain
 *  url in server compiles, so the same call works on every host. */
export const _styleParams = (options: MapOptions = {}): MapParams => {
  const { style = "liberty", ...rest } = options
  if (typeof style === "string") {
    if (!style.startsWith("id:")) return { ...rest, style: NAMED_STYLES[style] ?? style }
    const text = bufferText(+style.slice(3))
    if (!text) throw new Error("MapView: the style asset is empty or missing")
    return { ...rest, styleJson: text }
  }
  const response = style as FetchResponse
  return { ...rest, styleJson: typeof response.text === "function" ? response.text() : JSON.stringify(style) }
}

/** @internal marker items → a FeatureCollection of Points; a coordinate list → one LineString. */
export const _toGeoJson = (items: MarkerItem[] | LngLat[]): object => {
  if (items.length > 0 && Array.isArray(items[0])) {
    return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: items } }
  }
  return {
    type: "FeatureCollection",
    features: (items as MarkerItem[]).map(item => {
      const { id, lngLat, ...properties } = item
      return { type: "Feature", id, properties: { ...properties, id }, geometry: { type: "Point", coordinates: lngLat } }
    }),
  }
}

/**
 * Create a map view. `MapView.isSupported` reports whether this host registered a "map" view —
 * check it before offering the feature.
 */
// PURE IIFE so an app that never uses the map tree-shakes the whole plugin away.
export const MapView: {
  (options?: MapOptions): MapView
  /** Whether this host registered a "map" view. */
  readonly isSupported: boolean
} = /*#__PURE__*/ (() => {
  const factory = (options: MapOptions = {}): MapView => new MapViewElement(options) as unknown as MapView
  Object.defineProperty(factory, "isSupported", {
    get: (): boolean => ViewChannel.supports(NAME),
  })
  return factory as any
})()
