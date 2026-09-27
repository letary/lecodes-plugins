// map on the web: maplibre-gl, the JS sibling of the maplibre-native engine the iOS and Android
// halves use — the same style JSON, the same layer model; the rendering is a close cousin, not
// pixel-identical.
//
// This module is the registration-time half: it stays tiny so `MapView.isSupported` is a synchronous
// truth while maplibre-gl (~600 kB) loads lazily, on the first map instance, as its own chunk
// (mapImpl.ts). A call issued before the library landed waits for it.
//
// The channel is the contract's (../contract.d.ts): map.gen.ts is generated from it, mapImpl.ts
// implements its MapViewPlugin.

import { registerMapView, type MapViewPlugin, type PluginHost } from "./map.gen"

/** What the half needs of its bundler, handed over by whoever builds it: maplibre's worker as a URL
 *  of a script that stands alone, its stylesheet as text. Asked for with the first map, not before. */
export interface MapResources {
  workerUrl: string
  css: string
}

export const register = (host: PluginHost, resources: () => Promise<MapResources>): void => {
  if (typeof document === "undefined") return

  registerMapView(host, (params, events, doc): MapViewPlugin => {
    const el = doc.createElement("div")
    el.style.cssText = "background:#e8e6e1;overflow:hidden"

    let impl: MapViewPlugin | null = null
    let destroyed = false
    const loaded = Promise.all([import("./mapImpl"), resources()]).then(
      ([m, r]) => { if (!destroyed) impl = m.createMap(el, params, events, doc, r) },
      (e) => events.error({ message: `MapView: failed to load maplibre-gl — ${e instanceof Error ? e.message : String(e)}` }),
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
}
