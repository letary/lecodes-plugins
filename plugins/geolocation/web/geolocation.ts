// geolocation on the web: navigator.geolocation. The browser prompts for the permission on the
// first getCurrentPosition / watchPosition — the contract's "prompt on the first call that needs it".
//
// The channel is the contract's (../contract.d.ts): geolocation.gen.ts is generated from it, this
// file implements its GeolocationPlugin.

import { GeolocationError, registerGeolocation, type GeoOptions, type GeoPosition, type GeolocationCode, type GeolocationPlugin, type PluginHost } from "./geolocation.gen"

const position = (pos: GeolocationPosition): GeoPosition => ({
  latitude: pos.coords.latitude,
  longitude: pos.coords.longitude,
  accuracy: pos.coords.accuracy,
  altitude: pos.coords.altitude,
  heading: pos.coords.heading,
  speed: pos.coords.speed,
  timestamp: pos.timestamp,
})

const code = (e: GeolocationPositionError): GeolocationCode =>
  e.code === e.PERMISSION_DENIED ? "denied" : e.code === e.TIMEOUT ? "timeout" : "unavailable"

export const register = (host: PluginHost): void => {
  if (typeof navigator === "undefined" || !navigator.geolocation) return

  registerGeolocation(host, (_params, events): GeolocationPlugin => {
    let watchId: number | null = null

    const stopWatch = (): void => {
      if (watchId === null) return
      navigator.geolocation.clearWatch(watchId)
      watchId = null
    }

    return {
      getCurrent: (options?: GeoOptions) => new Promise<GeoPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(
        (pos) => resolve(position(pos)),
        (e) => reject(new GeolocationError(code(e))),
        { enableHighAccuracy: options?.highAccuracy ?? false, ...(options?.timeout === undefined ? {} : { timeout: options.timeout }) },
      )),

      // Resolves once the watch is live: on the permission grant when the Permissions API can report
      // it, otherwise on the first fix. A pre-fix error (a denial) rejects and unwinds. A second call
      // while watching resolves at once and keeps the first call's options.
      startWatch: (options?: GeoOptions) => new Promise<void>((resolve, reject) => {
        if (watchId !== null) return resolve()
        let settled = false
        const settle = (fn: () => void): void => { if (!settled) { settled = true; fn() } }

        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            settle(resolve)
            events.position(position(pos))
          },
          // After the watch is live, provider hiccups (a tunnel, airplane mode) are not fatal —
          // updates just pause. Only a pre-start error fails the call.
          (e) => settle(() => { stopWatch(); reject(new GeolocationError(code(e))) }),
          { enableHighAccuracy: options?.highAccuracy ?? false },
        )

        navigator.permissions?.query({ name: "geolocation" }).then((status) => {
          if (status.state === "granted") settle(resolve)
        }).catch(() => {})
      }),

      stopWatch,
      close: stopWatch,
    }
  })
}
