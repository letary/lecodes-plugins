// map on the web: maplibre-gl, the JS sibling of the maplibre-native engine the iOS and Android
// halves use — the same style JSON, the same layer model; the rendering is a close cousin, not
// pixel-identical. ONE map (mapImpl.ts `createMap`) behind both surfaces: the fullscreen View's
// instance and the host node's half (`UIMapNode`, Web Lite's `hostnode` feature).
//
// This module is the registration-time half: it stays tiny so `MapView.supported` is a synchronous
// truth while maplibre-gl (~600 kB) loads lazily, on the first map instance, as its own chunk
// (mapImpl.ts). A call issued before the library landed waits for it.
//
// The node's rules are the native node's (../ios/MapPlugin.swift):
//   - its props arrive one by one (the holder hands each write over, `kind` first), so the map is
//     made at the END of the task the node was made in (and once maplibre is in), from every prop
//     written by then — the style before anything loads;
//   - later writes are applied the same way, once per task: a style write reloads the style once
//     (and only when it differs from the one shown — `ready` fires again then), the camera props
//     written (`center` / `zoom` / `bearing` / `pitch`) are ONE jump to what was written with the
//     rest of the camera kept, the zoom range and the gestures are set;
//   - a call applies what is pending first: it sees every prop written before it (and waits for the
//     map when it comes before it is made);
//   - `destroy` (the node released) tears the map down; nothing is applied after it.
//
// The channel is the contract's (../contract.d.ts): map.gen.ts is generated from it, mapImpl.ts
// implements its MapViewPlugin and what UIMapNodeHalf's props change.

import { UIMapNodeError, registerMapView, registerUIMapNode, type MapParams, type MapViewPlugin, type PluginHost, type UIMapNodeHalf } from "./map.gen"
import type { MapController } from "./mapImpl"

/** What the half needs of its bundler, handed over by whoever builds it: maplibre's worker as a URL
 *  of a script that stands alone, its stylesheet as text. Asked for with the first map, not before. */
export interface MapResources {
  workerUrl: string
  css: string
}

type Prop = "style" | "center" | "zoom" | "bearing" | "pitch" | "zoomRange" | "gestures"

export const register = (host: PluginHost, resources: () => Promise<MapResources>): void => {
  if (typeof document === "undefined") return
  const engine = () => Promise.all([import("./mapImpl"), resources()])
  const failed = (what: string, e: unknown) => `${what}: failed to load maplibre-gl — ${e instanceof Error ? e.message : String(e)}`

  registerMapView(host, (params, events, doc): MapViewPlugin => {
    const el = doc.createElement("div")
    el.style.cssText = "background:#e8e6e1;overflow:hidden"

    let impl: MapViewPlugin | null = null
    let destroyed = false
    const loaded = engine().then(
      ([m, r]) => { if (!destroyed) impl = m.createMap(el, params, events, doc, r) },
      (e) => events.error({ message: failed("MapView", e) }),
    )
    const live = async (): Promise<MapViewPlugin> => {
      await loaded
      if (!impl) throw new Error("MapView: the map engine failed to load")
      return impl
    }

    return {
      el,
      ensureLayer: async (source, kind, options) => (await live()).ensureLayer(source, kind, options),
      removeLayer: async (source) => (await live()).removeLayer(source),
      setData: async (source, geojson) => (await live()).setData(source, geojson),
      flyTo: async (center, options) => (await live()).flyTo(center, options),
      jumpTo: async (center, options) => (await live()).jumpTo(center, options),
      fitPoints: async (points, options) => (await live()).fitPoints(points, options),
      setPadding: async (padding) => (await live()).setPadding(padding),
      getCamera: async () => (await live()).getCamera(),
      setUserLocation: async (lngLat, options) => (await live()).setUserLocation(lngLat, options),
      destroy: () => {
        destroyed = true
        impl?.destroy?.()
        impl = null
      },
    }
  })

  registerUIMapNode(host, (events, doc): UIMapNodeHalf => {
    const el = doc.createElement("div")
    el.style.cssText = "background:#e8e6e1;overflow:hidden"
    /** Every prop as written last, in the View's params' fields (the prop `styleUrl` is `style`):
     *  what the map is made from. */
    const props: MapParams = {}
    const dirty = new Set<Prop>()
    let map: MapController | null = null
    let making: Promise<MapController | null> | null = null
    /** The style the map shows: a write of the same one reloads nothing. */
    let shown: { url?: string, json?: string } = {}
    let queued = false
    let destroyed = false

    const make = (): Promise<MapController | null> => making ??= engine().then(
      ([m, r]) => {
        if (destroyed) return null
        // (what was written while maplibre loaded is in the props it is made from)
        dirty.clear()
        shown = { url: props.style, json: props.styleJson }
        map = m.createMap(el, props, events, doc, r)
        return map
      },
      (e) => { events.error({ message: failed("UIMapNode", e) }); return null },
    )

    /** Apply what was written since the last time — the first time makes the map from every prop.
     *  The map; null once destroyed (or when maplibre did not load). */
    const flush = (): Promise<MapController | null> => {
      queued = false
      if (destroyed) return Promise.resolve(null)
      if (!map) return make()
      const changed = new Set(dirty)
      dirty.clear()
      if (changed.has("style") && (shown.url !== props.style || shown.json !== props.styleJson)) {
        shown = { url: props.style, json: props.styleJson }
        map.setStyle(props.style, props.styleJson)
      }
      if (changed.has("center") || changed.has("zoom") || changed.has("bearing") || changed.has("pitch")) {
        map.jump(changed.has("center") ? props.center : undefined, changed.has("zoom") ? props.zoom : undefined,
          changed.has("bearing") ? props.bearing : undefined, changed.has("pitch") ? props.pitch : undefined)
      }
      if (changed.has("zoomRange")) map.setZoomRange(props.minZoom, props.maxZoom)
      if (changed.has("gestures")) map.setGestures(props.rotate, props.tilt)
      return Promise.resolve(map)
    }

    /** A prop changed: applied with the rest of its task, at the end of it. */
    const mark = (prop: Prop): void => {
      dirty.add(prop)
      if (queued) return
      queued = true
      queueMicrotask(() => { void flush() })
    }
    mark("style")   // the first flush makes the map, whatever the node was given

    /** The map, with every prop written before the call applied; a node without one rejects. */
    const live = async (): Promise<MapController> => {
      const m = await flush()
      if (!m) throw new UIMapNodeError("notReady")
      return m
    }

    return {
      el,
      setStyleUrl: (url) => { props.style = url; mark("style") },
      setStyleJson: (json) => { props.styleJson = json; mark("style") },
      setCenter: (center) => { props.center = center; mark("center") },
      setZoom: (zoom) => { props.zoom = zoom; mark("zoom") },
      setMinZoom: (zoom) => { props.minZoom = zoom; mark("zoomRange") },
      setMaxZoom: (zoom) => { props.maxZoom = zoom; mark("zoomRange") },
      setBearing: (bearing) => { props.bearing = bearing; mark("bearing") },
      setPitch: (pitch) => { props.pitch = pitch; mark("pitch") },
      setRotate: (rotate) => { props.rotate = rotate; mark("gestures") },
      setTilt: (tilt) => { props.tilt = tilt; mark("gestures") },
      ensureLayer: async (source, kind, options) => (await live()).ensureLayer(source, kind, options),
      removeLayer: async (source) => { const m = await flush(); if (m) await m.removeLayer(source) },
      setData: async (source, geojson) => (await live()).setData(source, geojson),
      flyTo: async (center, options) => (await live()).flyTo(center, options),
      jumpTo: async (center, options) => (await live()).jumpTo(center, options),
      fitPoints: async (points, options) => (await live()).fitPoints(points, options),
      setPadding: async (padding) => (await live()).setPadding(padding),
      getCamera: async () => (await live()).getCamera(),
      setUserLocation: async (lngLat, options) => (await live()).setUserLocation(lngLat, options),
      destroy: () => {
        destroyed = true
        map?.destroy?.()
        map = null
      },
    }
  })
}
