// Geolocation — the device position: `getCurrent()` and `watch()`.
//
// Hand-written over the generated wire because the public API is not the wire's: the wire has ONE
// watch per session (startWatch / stopWatch + the `position` event), the app gets `watch(callback)`
// — any number of subscribers on that one watch, each with its own `stop()`.
//
// The OS permission prompt happens on the first call that needs it (host-side); a denial is a
// rejection. Both methods reject on a host without the service BEFORE any permission path.

import { GeolocationBase, NAME } from "./geolocation.gen"
import type { GeoOptions, GeoPosition } from "../contract"

export type { GeoOptions, GeoPosition }

/** A live `Geolocation.watch()` subscription — `stop()` it when the screen goes away. */
export interface GeoWatch {
  stop(): void
}

/**
 * The device position. `Geolocation.isSupported` reports whether this host registered the
 * service — check it before offering location features.
 */
// PURE IIFE so an app that never uses location tree-shakes the whole plugin away.
export const Geolocation: {
  /** Whether this host registered a "geolocation" service. */
  readonly isSupported: boolean
  /** One position fix. Prompts for permission on first use; rejects on denial ("denied"), no
   *  provider ("unavailable"), or `options.timeout` elapsing ("timeout"). */
  getCurrent(options?: GeoOptions): Promise<GeoPosition>
  /** Continuous updates. Resolves once watching (permission granted + provider started) — so a
   *  denial is a rejection, never a silently dead callback. One host watch serves every
   *  subscriber; the options of the watch that starts it win. Always `stop()` when done. */
  watch(callback: (position: GeoPosition) => void, options?: GeoOptions): Promise<GeoWatch>
} = /*#__PURE__*/ (() => {
  let client: GeolocationBase | null = null
  const service = (): GeolocationBase => client ??= new GeolocationBase()

  // Watch state: one host watch fans out to N subscribers, the last stop() releases it.
  const watchers: ((position: GeoPosition) => void)[] = []
  let positionHooked = false
  let startPromise: Promise<void> | null = null

  const assertSupported = (): void => {
    // Fail before the host is touched — a permission dialog for a feature that can't exist
    // would be worse than the error.
    if (!GeolocationBase.supports(NAME)) {
      throw new Error('Geolocation isn\'t available on this host — it needs a registered "geolocation" service.')
    }
  }

  const removeWatcher = (callback: (position: GeoPosition) => void): void => {
    const i = watchers.indexOf(callback)
    if (i >= 0) watchers.splice(i, 1)
    if (watchers.length === 0 && startPromise !== null) {
      startPromise = null
      service().stopWatch().catch(() => {})
    }
  }

  const geolocation = {
    async getCurrent(options?: GeoOptions): Promise<GeoPosition> {
      assertSupported()
      return await service().getCurrent(options ?? {})
    },

    async watch(callback: (position: GeoPosition) => void, options?: GeoOptions): Promise<GeoWatch> {
      assertSupported()
      if (!positionHooked) {
        positionHooked = true
        service().on("position", position => {
          if (position) for (const cb of [...watchers]) cb(position)
        })
      }
      watchers.push(callback)
      startPromise ??= service().startWatch(options ?? {})
      try {
        await startPromise
      } catch (e) {
        // The watch never started — unwind without the stopWatch a live watch would need.
        const i = watchers.indexOf(callback)
        if (i >= 0) watchers.splice(i, 1)
        if (watchers.length === 0) startPromise = null
        throw e
      }
      let stopped = false
      return {
        stop(): void {
          if (stopped) return
          stopped = true
          removeWatcher(callback)
        },
      }
    },
  }
  Object.defineProperty(geolocation, "isSupported", {
    get: (): boolean => GeolocationBase.supports(NAME),
  })
  return geolocation as any
})()
