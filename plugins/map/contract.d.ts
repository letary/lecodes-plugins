// map — a vector map (maplibre-native on iOS / Android, maplibre-gl in the browser), on two surfaces
// with one set of methods (MapMethods): the fullscreen VIEW "map" (`MapView`: its own layer,
// `Router.push`, widgets over it) and the HOST NODE "map" (`UIMapNode`: a box in a screen's layout,
// docs/plans/host-node-plan.md in core). On every platform both are one map class under two thin
// instances — on the web maplibre-gl, the node's on Web Lite (the web player draws no host node: an
// empty box there).
// The wire is lower than the app-facing wrappers: the shared logic in sdk/ resolves a style to a url
// or to text, turns marker items into GeoJSON, queues calls until `ready` and re-applies the
// style-lifetime state (layers, data, padding, the user puck) after every style load.
//
// The plugin never touches the location hardware: the user puck is fed by the app.

import type { Json, UIHostNode, View, f64 } from "lecodes-sdk/plugin"

/** `[longitude, latitude]` — GeoJSON order. */
export type LngLat = [f64, f64]

export interface MapParams {
  /** A style URL the map fetches itself. */
  style?: string
  /** A style as JSON text; wins over `style`. It has no base url: every url INSIDE it (sources,
   *  sprite, glyphs) must be absolute. */
  styleJson?: string
  center?: LngLat
  /** Default 12 with a center. */
  zoom?: f64
  minZoom?: f64
  maxZoom?: f64
  /** Degrees clockwise from north. */
  bearing?: f64
  /** Degrees from the vertical. */
  pitch?: f64
  /** The two-finger rotate gesture. Default true. */
  rotate?: boolean
  /** The two-finger tilt gesture. Default false. */
  tilt?: boolean
}

export interface MapCamera {
  center: LngLat
  zoom: f64
  bearing: f64
  pitch: f64
}

/** A feature of a managed source under a tap. */
export interface MapFeature {
  /** The source's name — the layer's name in the app. */
  source: string
  id: string | f64 | null
  properties: { [key: string]: Json }
}

export interface MapTap {
  lngLat: LngLat
  /** View-space point, logical px. */
  point: [f64, f64]
  /** Absent for a tap that hit no feature of a managed source. A tap on a CLUSTER zooms in and
   *  sends no event. */
  feature?: MapFeature
}

export interface MapEvents {
  /** The style loaded and the map takes calls. Fires again after every style reload. */
  ready: void
  tap: MapTap
  /** The camera settled after a gesture or an animation. */
  moveEnd: MapCamera
  /** A problem that is never fatal: a style that would not load, a source out of reach. */
  error: { message: string }
}

export type MapLayerKind = "markers" | "line"

/** The keys of both kinds; a half reads the ones of the kind it is asked for. */
export interface MapLayerOptions {
  /** markers: group nearby markers (a cluster tap zooms in). Default false. */
  cluster?: boolean
  /** markers: px. Default 50. */
  clusterRadius?: f64
  /** markers: the zoom at which clusters stop forming. */
  clusterMaxZoom?: f64
  /** line. */
  color?: string
  /** line: px. Default 4. */
  width?: f64
  /** line: 0–1. Default 1. */
  opacity?: f64
}

export interface MapCameraMove {
  zoom?: f64
  bearing?: f64
  pitch?: f64
  /** flyTo only: ms. Default 600. */
  duration?: f64
}

/** Px, or a share of the view's size as "NN%". */
export type MapInset = f64 | string

export interface MapPadding {
  top?: MapInset
  left?: MapInset
  bottom?: MapInset
  right?: MapInset
}

export interface MapFitOptions {
  /** Around the points: px on every edge, or per edge. Added to the view padding. */
  padding?: f64 | MapPadding
  /** Default: 16 for one point, none otherwise. */
  maxZoom?: f64
  /** Default true. */
  animate?: boolean
}

export interface MapUserLocationOptions {
  /** Meters — the halo around the dot. */
  accuracy?: f64 | null
  /** Degrees clockwise from north — the direction wedge; null hides it. */
  heading?: f64 | null
  /** The waves that spread from the dot. Default true. */
  pulse?: boolean
}

/** The methods of both surfaces: the View's and the node's, one implementation per platform. */
export interface MapMethods {
  /** Make sure the GeoJSON source `source` exists. A source the style declares is used as is (its
   *  layers draw, only data flows); otherwise the half creates it with the default layers of `kind`.
   *  @rejects notReady */
  ensureLayer(source: string, kind: MapLayerKind, options?: MapLayerOptions): Promise<void>
  removeLayer(source: string): Promise<void>
  /** Replace the data of a GeoJSON source: a Feature or a FeatureCollection.
   *  @rejects notReady */
  setData(source: string, geojson: Json): Promise<void>

  flyTo(center: LngLat, options?: MapCameraMove): Promise<void>
  jumpTo(center: LngLat, options?: MapCameraMove): Promise<void>
  /** Fit the camera to the points.
   *  @rejects noPoints */
  fitPoints(points: LngLat[], options?: MapFitOptions): Promise<void>
  /** The part of the view covered by the app's UI; camera moves center inside the rest. */
  setPadding(padding: MapPadding): Promise<void>
  /** @rejects notReady */
  getCamera(): Promise<MapCamera>

  /** Move the user puck; null hides it. */
  setUserLocation(lngLat: LngLat | null, options?: MapUserLocationOptions): Promise<void>
}

/** The node's props: the View's params, LIVE. The props one commit writes land together: a style
 *  write reloads the style once (the map then fires `ready` again), a camera write (`center`,
 *  `zoom`, `bearing`, `pitch`) is one jump to what was written, the rest of the camera kept. The
 *  first commit makes the map, with these as its first view — the style before anything else: the
 *  map loads one style, never a default one first. */
export interface MapProps {
  /** A style URL the map fetches itself. (`style` is the element's `.style()`: the View's param
   *  `style`, renamed.) */
  styleUrl?: string
  /** A style as JSON text; wins over `styleUrl`. It has no base url: every url INSIDE it (sources,
   *  sprite, glyphs) must be absolute. */
  styleJson?: string
  center?: LngLat
  /** Default 12 with a center, when the map is made. */
  zoom?: f64
  minZoom?: f64
  maxZoom?: f64
  /** Degrees clockwise from north. */
  bearing?: f64
  /** Degrees from the vertical. */
  pitch?: f64
  /** The two-finger rotate gesture. Default true. */
  rotate?: boolean
  /** The two-finger tilt gesture. Default false. */
  tilt?: boolean
}

export interface MapView extends View<"map", MapParams, MapEvents>, MapMethods {}

/** The map as a node of the layout: a box in a screen, sized by its styles, drawn by the host's map
 *  view; the holder paints the box (radius, border, shadow) over it. */
export interface UIMap extends UIHostNode<"map", MapProps, MapEvents>, MapMethods {}
