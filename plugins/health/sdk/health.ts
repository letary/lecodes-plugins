// Health — activity totals from the system's health store: `available()`, `request(types)`,
// `sum(type, range)`.
//
// Hand-written over the generated wire for what a host without the service answers — `available()`
// resolves false there (an app asks it to decide whether to offer the feature at all), `request()`
// and `sum()` reject "unavailable", the code the app already handles for a device without the store
// — and for the app's mistakes, said here before the host is touched: a range that is not one
// (`from` not before `to`, not numbers), an unknown bucket, more buckets than a call answers.
//
// Read only, totals only. What the person answered to request() is not reported: iOS never says
// whether it may read (a refusal sums to zeros), Android says it through sum() (`denied`).

import { HealthBase, supports } from "./health.gen"
import type { HealthBucket, HealthRange, HealthTotal, HealthType } from "../contract"

export type { HealthBucket, HealthRange, HealthTotal, HealthType }

/** The most rows one sum() answers — the halves hold the wire to the same count. */
const MAX_BUCKETS = 10_000
/** A bucket's length for that count: a calendar day is 23 to 25 hours, counted as 24 by both the
 *  wrapper and the halves. */
const BUCKET_MS: Record<HealthBucket, number> = { hour: 3_600_000, day: 86_400_000 }

/**
 * Activity totals from the device's health store — Apple HealthKit, Android Health Connect: steps,
 * distance (meters), active energy (kilocalories), whole or by the hour / the calendar day,
 * de-duplicated across the phone and the watch. `Health.supported` reports whether this host
 * registered the service; `available()` whether the device has the store.
 */
// PURE IIFE so an app that never reads health data tree-shakes the whole plugin away.
export const Health: {
  /** Whether this host registered a "health" service. */
  readonly supported: boolean
  /** Whether the device has the store: HealthKit's data (an iPhone; an iPad from iPadOS 17), Health
   *  Connect installed and usable on Android. Never prompts. On a host without the service: false. */
  available(): Promise<boolean>
  /** Show the store's sheet that asks to READ `types` — where the store still has something to ask.
   *  Resolves when it is done and does not say what the person chose: iOS never tells an app whether
   *  it may read (a refused type sums to zeros), on Android sum() rejects "denied" for one. Rejects
   *  "unavailable" (no store — also on a host without the service), "failed" (the sheet could not be
   *  shown). An empty list resolves at once. */
  request(types: HealthType[]): Promise<void>
  /** The total of `type` (steps: a count, distance: meters, activeEnergy: kilocalories) over
   *  `range` ({ from, to } in ms since the epoch, `to` excluded): one row, or with `bucket` a row
   *  per hour / calendar day from `from`, the last ending at `to` — 0 where nothing was recorded.
   *  De-duplicated across sources. At most 10000 buckets. Rejects "unavailable" (no store — also on
   *  a host without the service), "denied" (Android: reading `type` not granted; iOS: never asked),
   *  "failed" (the store refused the query). */
  sum(type: HealthType, range: HealthRange): Promise<HealthTotal[]>
} = /*#__PURE__*/ (() => {
  let client: HealthBase | null = null
  const service = (): HealthBase => client ??= new HealthBase()

  const health = {
    async available(): Promise<boolean> {
      if (!supports()) return false
      return await service().available()
    },

    async request(types: HealthType[]): Promise<void> {
      if (!Array.isArray(types)) throw new Error('Health.request: a list of types — ["steps", "distance", "activeEnergy"]')
      if (!supports()) throw new Error("unavailable")
      const unique = [...new Set(types)]
      if (unique.length === 0) return
      await service().request(unique)
    },

    async sum(type: HealthType, range: HealthRange): Promise<HealthTotal[]> {
      const from = range?.from
      const to = range?.to
      const bucket = range?.bucket
      if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to)) {
        throw new Error("Health.sum: range.from and range.to are ms since the epoch")
      }
      if (from >= to) throw new Error("Health.sum: range.from must be before range.to")
      if (bucket !== undefined && bucket !== "hour" && bucket !== "day") {
        throw new Error(`Health.sum: range.bucket is "hour" or "day" (got ${JSON.stringify(bucket)})`)
      }
      if (bucket !== undefined && Math.ceil((to - from) / BUCKET_MS[bucket]) > MAX_BUCKETS) {
        throw new Error(`Health.sum: more than ${MAX_BUCKETS} buckets — a shorter range or a longer bucket`)
      }
      if (!supports()) throw new Error("unavailable")
      return await service().sum(type, bucket === undefined ? { from, to } : { from, to, bucket })
    },
  }
  Object.defineProperty(health, "supported", {
    get: (): boolean => supports(),
  })
  return health as any
})()
