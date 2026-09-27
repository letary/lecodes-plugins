// The maplibre-gl half of the map on the web — loaded lazily by map.ts. It implements the contract's
// MapViewPlugin (map.gen.ts) and mirrors the iOS half (../ios/MapPlugin.swift + MapLayers.swift)
// rule for rule.
//
// Deliberately NOT here, as on the devices: maplibre's geolocate control (the puck is our own
// GeoJSON source fed by the app), attribution/logo chrome, any permission prompt.

import { Map as MapLibreMap, LngLatBounds, setWorkerUrl, type GeoJSONSource, type MapGeoJSONFeature, type LayerSpecification, type PaddingOptions, type StyleSpecification } from "maplibre-gl"
import type { FeatureCollection, GeoJSON } from "geojson"
import {
  MapViewError, type Json, type MapCamera, type MapCameraMove, type MapFeatureId, type MapFitOptions, type MapFitOptionsPadding,
  type MapLayerKind, type MapLayerOptions, type MapPadding, type MapParams, type MapTap, type MapViewEvents, type MapViewPlugin,
} from "./map.gen"
import type { MapResources } from "./map"

type LngLat = [number, number]
type Managed = { kind: "styleOwned" } | { kind: MapLayerKind, layerIds: string[] }

const DEFAULT_MARKER_COLOR = "#DD4B40"
const USER_SOURCE = "lecodes-user"
const USER_HALO = "lecodes-user-halo"
const USER_DOT = "lecodes-user-dot"
const USER_HEADING = "lecodes-user-heading"
const USER_IMAGE = "lecodes-user-heading"
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] }

const ensureCss = (doc: Document, css: string): void => {
  if (doc.head.querySelector("style[data-maplibre-css]")) return
  const style = doc.createElement("style")
  style.setAttribute("data-maplibre-css", "")
  style.textContent = css
  doc.head.appendChild(style)
}

/** `[lng, lat]` → the same pair; a latitude off the globe → null. */
const coordinate = (value: LngLat | null | undefined): LngLat | null => {
  if (!value) return null
  const [lng, lat] = value
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lat < -90 || lat > 90) return null
  return [lng, lat]
}

/** A padding (one number for every edge, or `{ top, left, bottom, right }` of px numbers / "NN%"
 *  strings) → px insets for a view of width × height. */
const insets = (value: MapFitOptionsPadding | MapPadding | undefined, width: number, height: number): Required<PaddingOptions> => {
  if (typeof value === "number") return { top: value, left: value, bottom: value, right: value }
  const spec: MapPadding = value ?? {}
  const edge = (v: number | string | undefined, extent: number): number => {
    if (typeof v === "number") return v
    if (typeof v === "string" && v.endsWith("%")) {
      const pct = Number(v.slice(0, -1))
      return Number.isFinite(pct) ? extent * pct / 100 : 0
    }
    return 0
  }
  return { top: edge(spec.top, height), left: edge(spec.left, width), bottom: edge(spec.bottom, height), right: edge(spec.right, width) }
}

/** The `id` an item was given, as the contract carries it: a string or a number, else none. */
const featureId = (id: unknown): MapFeatureId | null =>
  typeof id === "string" || typeof id === "number" ? id : null

/** Plugin-built marker layers read `color` — fill the default where an item didn't say. */
const withMarkerDefaults = (geojson: any): any => {
  if (!geojson || geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) return geojson
  return {
    ...geojson,
    features: geojson.features.map((f: any) => {
      const props = f?.properties ?? {}
      return props.color == null ? { ...f, properties: { ...props, color: DEFAULT_MARKER_COLOR } } : f
    }),
  }
}

/** The 24×24 arrow head (north) the heading layer rotates per feature, at 2× for crispness. */
const arrowImage = (doc: Document): ImageData | null => {
  const canvas = doc.createElement("canvas")
  canvas.width = 48
  canvas.height = 48
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.scale(2, 2)
  ctx.beginPath()
  ctx.moveTo(12, 1)
  ctx.lineTo(18, 10)
  ctx.lineTo(12, 7.5)
  ctx.lineTo(6, 10)
  ctx.closePath()
  ctx.fillStyle = "rgb(26,128,255)"
  ctx.fill()
  ctx.strokeStyle = "#fff"
  ctx.lineWidth = 1
  ctx.stroke()
  return ctx.getImageData(0, 0, 48, 48)
}

// The accuracy halo is in meters; on the web that's one zoom-driven expression instead of the
// per-move rescale the native side does: px = m · 2^zoom / (156543.03 · cos(lat)) — exponential
// base 2 in zoom, exactly. Below the dot it's noise (0), above ~a screen it's meaningless (600).
const haloRadius = (accuracy: number, lat: number): any => {
  const base = accuracy / (156543.03392 * Math.cos(lat * Math.PI / 180))
  const radius = ["interpolate", ["exponential", 2], ["zoom"], 0, base, 22, base * 4194304]
  return ["step", radius, 0, 10, ["min", 600, radius]]
}

export const createMap = (el: HTMLElement, params: MapParams, events: MapViewEvents, doc: Document, resources: MapResources): MapViewPlugin => {
  // The worker ships as a separate file that imports maplibre's shared chunk relative to itself;
  // maplibre derives its URL from import.meta.url of ITS module, which a bundled host no longer has
  // next to it. Whoever builds the half hands over the URL of a worker script that stands alone.
  setWorkerUrl(resources.workerUrl)
  ensureCss(doc, resources.css)

  const rotate = params.rotate !== false
  const tilt = params.tilt === true
  const center = coordinate(params.center)
  // `styleJson` is a style the SDK wrapper already read (a bundled `asset()`, a file the app read,
  // an inline style object); otherwise `style` is a URL maplibre fetches itself.
  const style = ((): string | StyleSpecification | null => {
    if (params.styleJson !== undefined) {
      try { return JSON.parse(params.styleJson) } catch { return null }
    }
    return params.style ?? null
  })()
  if (!style) events.error({ message: "MapView: `style` must be a URL or a style JSON" })

  const map = new MapLibreMap({
    container: el,
    style: style ?? { version: 8, sources: {}, layers: [] },
    center: center ?? [0, 0],
    zoom: params.zoom ?? (center ? 12 : 0),
    bearing: params.bearing ?? 0,
    pitch: params.pitch ?? 0,
    minZoom: params.minZoom,
    maxZoom: params.maxZoom,
    attributionControl: false,
    dragRotate: rotate,
    pitchWithRotate: tilt,
    touchPitch: tilt,
  })
  if (!rotate) map.touchZoomRotate.disableRotation()

  let ready = false
  let managed = new Map<string, Managed>()
  let paddingSpec: MapPadding = {}
  let puck: { accuracy: number | null, lat: number } | null = null

  const size = (): [number, number] => [el.clientWidth, el.clientHeight]
  const cameraPayload = (): MapCamera => {
    const c = map.getCenter()
    return { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }
  }
  const layersOf = (source: string): string[] =>
    (map.getStyle()?.layers ?? []).filter((l) => (l as any).source === source).map((l) => l.id)

  // ---- events ---------------------------------------------------------------------------------

  map.on("load", () => {
    // A style reload (only on a URL change today) drops every runtime source/layer.
    managed = new Map()
    puck = null
    ready = true
    // `ready` first: applying the padding moves the camera, and a `moveEnd` is an event of a map
    // that is ready — the order of the native halves.
    events.ready()
    applyPadding()
  })
  // Before the style is up an error is fatal (a bad URL, a blocked host); after that maplibre
  // also reports every missing tile/sprite here — the native halves don't, so neither do we.
  map.on("error", (e) => {
    if (ready) return
    events.error({ message: e?.error?.message ?? "MapView: failed to load the style" })
  })
  map.on("moveend", () => { if (ready) events.moveEnd(cameraPayload()) })
  map.on("resize", () => applyPadding())

  // One single tap → hit-test our sources → `tap`. Wait out maplibre's double-tap (zoom) so a
  // double tap doesn't also count as a tap — the same rule the iOS recognizer applies.
  let pendingTap: ReturnType<typeof setTimeout> | null = null
  map.on("dblclick", () => { if (pendingTap) { clearTimeout(pendingTap); pendingTap = null } })
  map.on("click", (e) => {
    if (pendingTap) clearTimeout(pendingTap)
    const point = e.point
    const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat]
    pendingTap = setTimeout(() => { pendingTap = null; handleTap(point, lngLat) }, 300)
  })

  const handleTap = (point: { x: number, y: number }, lngLat: LngLat) => {
    if (!ready) return
    const tap: MapTap = { lngLat, point: [point.x, point.y] }
    for (const name of managed.keys()) {
      const layerIds = layersOf(name)
      if (layerIds.length === 0) continue
      let features: MapGeoJSONFeature[]
      try { features = map.queryRenderedFeatures([point.x, point.y], { layers: layerIds }) } catch { continue }
      const feature = features[0]
      if (!feature) continue
      const props = feature.properties ?? {}
      // A cluster tap zooms to the level where it splits — no event.
      if (props.cluster === true || props.cluster === "true") {
        const source = map.getSource<GeoJSONSource>(name)
        const coords = feature.geometry.type === "Point" ? (feature.geometry.coordinates as LngLat) : lngLat
        source?.getClusterExpansionZoom(Number(props.cluster_id)).then(
          (zoom) => map.easeTo({ center: coords, zoom }),
          () => { /* stale cluster — ignore */ },
        )
        return
      }
      const id = props.id ?? feature.id
      events.tap({ ...tap, feature: { source: name, id: featureId(id), properties: props as { [key: string]: Json } } })
      return
    }
    events.tap(tap)
  }

  // ---- methods --------------------------------------------------------------------------------

  const notReady = (): Error => new MapViewError("notReady")

  const setData = (name: string, geojson: Json): void => {
    if (!ready) throw notReady()
    const source = map.getSource<GeoJSONSource>(name)
    if (!source || source.type !== "geojson") {
      throw new Error(`unknown GeoJSON source "${name}" — call ensureLayer / map.markers(name) first, or declare it in the style`)
    }
    const entry = managed.get(name)
    void source.setData((entry?.kind === "markers" ? withMarkerDefaults(geojson) : geojson) as unknown as GeoJSON)
  }

  const ensureLayer = (name: string, kind: MapLayerKind, options: MapLayerOptions = {}): void => {
    if (!ready) throw notReady()
    if (managed.has(name)) return
    if (map.getSource(name)) {
      managed.set(name, { kind: "styleOwned" })
      return
    }
    managed.set(name, { kind, layerIds: addDefaultLayers(name, kind, options) })
  }

  const removeLayer = (name: string): void => {
    const entry = managed.get(name)
    if (!entry) return
    managed.delete(name)
    if (entry.kind === "styleOwned") {
      map.getSource<GeoJSONSource>(name)?.setData(EMPTY)
      return
    }
    for (const id of entry.layerIds) if (map.getLayer(id)) map.removeLayer(id)
    if (map.getSource(name)) map.removeSource(name)
  }

  const addDefaultLayers = (name: string, kind: MapLayerKind, options: MapLayerOptions): string[] => {
    const clustered = kind === "markers" && options.cluster === true
    map.addSource(name, {
      type: "geojson",
      data: EMPTY,
      ...(clustered ? {
        cluster: true,
        clusterRadius: options.clusterRadius ?? 50,
        ...(options.clusterMaxZoom === undefined ? {} : { clusterMaxZoom: options.clusterMaxZoom }),
      } : {}),
    })

    const layers: LayerSpecification[] = []
    if (kind === "line") {
      layers.push({
        id: `${name}-line`, type: "line", source: name,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": options.color ?? "rgb(255,64,51)",
          "line-width": options.width ?? 4,
          "line-opacity": options.opacity ?? 1,
        },
      })
    } else {
      const notCluster: any[] = clustered ? [["!", ["has", "point_count"]]] : []
      layers.push({
        id: `${name}-dot`, type: "circle", source: name,
        ...(clustered ? { filter: ["!", ["has", "point_count"]] } : {}),
        paint: { "circle-radius": 8, "circle-color": ["get", "color"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
      })
      layers.push({
        id: `${name}-icon`, type: "symbol", source: name,
        filter: ["all", ...notCluster, ["has", "icon"]],
        layout: { "icon-image": ["get", "icon"], "icon-allow-overlap": true, "icon-ignore-placement": true },
      })
      layers.push({
        id: `${name}-label`, type: "symbol", source: name,
        filter: ["all", ...notCluster, ["has", "title"]],
        layout: { "text-field": ["get", "title"], "text-size": 12, "text-anchor": "top", "text-offset": [0, 0.9], "text-optional": true },
        paint: { "text-color": "#000", "text-halo-color": "#fff", "text-halo-width": 1.2 },
      })
      if (clustered) {
        layers.push({
          id: `${name}-clusters`, type: "circle", source: name, filter: ["has", "point_count"],
          paint: { "circle-radius": 18, "circle-color": "rgb(59,122,214)", "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
        })
        layers.push({
          id: `${name}-cluster-count`, type: "symbol", source: name, filter: ["has", "point_count"],
          layout: { "text-field": ["to-string", ["get", "point_count"]], "text-size": 13, "text-allow-overlap": true, "text-ignore-placement": true },
          paint: { "text-color": "#fff" },
        })
      }
    }
    // Always under the user puck, otherwise on top of the style.
    const below = puck && map.getLayer(USER_HALO) ? USER_HALO : undefined
    for (const layer of layers) map.addLayer(layer, below)
    return layers.map((l) => l.id)
  }

  const moveCamera = (at: LngLat, options: MapCameraMove = {}, animated: boolean): void => {
    const center = coordinate(at)
    if (!center) throw new Error(`the latitude ${at[1]} is off the globe`)
    const target = {
      center,
      ...(options.zoom === undefined ? {} : { zoom: options.zoom }),
      ...(options.bearing === undefined ? {} : { bearing: options.bearing }),
      ...(options.pitch === undefined ? {} : { pitch: options.pitch }),
    }
    if (animated) map.flyTo({ ...target, duration: options.duration ?? 600 })
    else map.jumpTo(target)
  }

  const fitPoints = (all: LngLat[], options: MapFitOptions = {}): void => {
    const points = all.map(coordinate).filter((p): p is LngLat => p !== null)
    if (points.length === 0) throw new MapViewError("noPoints")
    const animate = options.animate !== false
    const [w, h] = size()
    const bounds = new LngLatBounds(points[0]!, points[0]!)
    for (const p of points) bounds.extend(p)
    // A single point has no extent: fit would zoom to the maximum, so cap it.
    const maxZoom = options.maxZoom ?? (points.length === 1 ? 16 : undefined)
    map.fitBounds(bounds, {
      padding: insets(options.padding, w, h),
      ...(maxZoom !== undefined ? { maxZoom } : {}),
      duration: animate ? 600 : 0,
    })
  }

  const applyPadding = () => {
    const [w, h] = size()
    if (w === 0 || h === 0) return
    map.setPadding(insets(paddingSpec, w, h))
  }

  const ensurePuck = () => {
    if (puck) return
    map.addSource(USER_SOURCE, { type: "geojson", data: EMPTY })
    const image = arrowImage(doc)
    if (image && !map.hasImage(USER_IMAGE)) map.addImage(USER_IMAGE, image, { pixelRatio: 2 })
    map.addLayer({
      id: USER_HALO, type: "circle", source: USER_SOURCE,
      paint: { "circle-color": "rgba(26,128,255,0.18)", "circle-radius": 0, "circle-pitch-alignment": "map" },
    })
    map.addLayer({
      id: USER_HEADING, type: "symbol", source: USER_SOURCE, filter: ["has", "heading"],
      layout: { "icon-image": USER_IMAGE, "icon-rotate": ["get", "heading"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true },
    })
    map.addLayer({
      id: USER_DOT, type: "circle", source: USER_SOURCE,
      paint: { "circle-radius": 7, "circle-color": "rgb(26,128,255)", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 },
    })
    puck = { accuracy: null, lat: 0 }
  }

  const setUserLocation = (lngLat: LngLat | null, accuracy: number | null, heading: number | null): void => {
    if (!ready) return
    ensurePuck()
    const source = map.getSource<GeoJSONSource>(USER_SOURCE)
    if (!source || !puck) return
    if (!lngLat) {
      void source.setData(EMPTY)
      return
    }
    void source.setData({
      type: "Feature",
      properties: heading == null ? {} : { heading },
      geometry: { type: "Point", coordinates: lngLat },
    })
    puck.accuracy = accuracy
    puck.lat = lngLat[1]
    map.setPaintProperty(USER_HALO, "circle-radius", accuracy != null && accuracy > 0 ? haloRadius(accuracy, lngLat[1]) : 0)
  }

  return {
    el,
    ensureLayer,
    removeLayer,
    setData,
    flyTo: (center, options) => moveCamera(center, options, true),
    jumpTo: (center, options) => moveCamera(center, options, false),
    fitPoints,
    setPadding: (padding) => {
      paddingSpec = padding
      applyPadding()
    },
    getCamera: cameraPayload,
    setUserLocation: (lngLat, options) => setUserLocation(coordinate(lngLat), options?.accuracy ?? null, options?.heading ?? null),
    destroy: () => {
      if (pendingTap) clearTimeout(pendingTap)
      map.remove()
    },
  }
}
