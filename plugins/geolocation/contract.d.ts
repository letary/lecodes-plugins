// geolocation — the device position.
// The wire has ONE watch per session (startWatch / stopWatch + the `position` event); the
// app-facing `Geolocation.watch(callback)` fans it out to its subscribers in sdk/.
//
// A session opens without a prompt. The OS permission prompt belongs to the first call that needs
// the position.

import type { Service, f64 } from "lecodes-sdk/plugin"

export interface GeoOptions {
  /** Prefer the precise (GPS) provider — slower first fix, more battery. Default false. */
  highAccuracy?: boolean
  /** getCurrent only: reject with "timeout" when no fix arrives in this many ms. */
  timeout?: f64
}

export interface GeoPosition {
  latitude: f64
  longitude: f64
  /** Horizontal accuracy radius, meters. */
  accuracy: f64
  /** Meters above sea level; null when the provider does not know. */
  altitude: f64 | null
  /** Direction of travel, degrees clockwise from north; null when stationary or unknown. */
  heading: f64 | null
  /** Ground speed, m/s; null when unknown. */
  speed: f64 | null
  /** When the fix was taken, ms since the epoch. */
  timestamp: f64
}

export interface GeolocationParams {}

export interface GeolocationEvents {
  /** A fix of the live watch. */
  position: GeoPosition
}

export interface Geolocation extends Service<"geolocation", GeolocationParams, GeolocationEvents> {
  /** One fix.
   *  @rejects denied unavailable timeout */
  getCurrent(options?: GeoOptions): Promise<GeoPosition>
  /** Start the session's watch; resolves once it is live (permission granted, provider started).
   *  A second call while watching resolves at once and keeps the first call's options.
   *  @rejects denied unavailable */
  startWatch(options?: GeoOptions): Promise<void>
  stopWatch(): Promise<void>
}
