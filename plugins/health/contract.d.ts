// health — activity data the system's health store keeps: Apple HealthKit on iOS, Health Connect on
// Android. READ only, totals only: how many steps, how far, how much active energy, over a range of
// time — whole, or bucket by bucket (an hour, a calendar day). No writing, no raw samples, no
// delivery in the background.
//
// A total is the store's own, de-duplicated across the sources that recorded it (the phone AND the
// watch count the same walk once): HealthKit's cumulative statistics, Health Connect's aggregates.
// Never a sum of samples.
//
// A data type is a string of HealthType, its unit fixed: steps (a count), distance (meters),
// activeEnergy (kilocalories). A type added later is a new string here and a row of each half's table.
//
// The permission to READ a type is the store's own, asked by request() — not one of the host's
// permission kinds: there is no `@permission` here. What the person answered is not reported, and
// cannot be on iOS: HealthKit never tells an app whether it may read (a refusal looks like no data).
// So a refused type sums to zeros on iOS and rejects `denied` on Android, where the grant is known
// (iOS tells only a type it was never asked about: `denied` too).
//
// A session opens without a prompt; available() never prompts.
//
// No web half: a browser has no health store.

import type { Service, f64 } from "lecodes-sdk/plugin"

/** A data type and its unit: `steps` a count, `distance` meters, `activeEnergy` kilocalories.
 *  iOS: HealthKit's stepCount, distanceWalkingRunning, activeEnergyBurned. Android: Health Connect's
 *  StepsRecord, DistanceRecord, ActiveCaloriesBurnedRecord — its distance is every distance the
 *  store holds (a ride too), iOS' the distance on foot. */
export type HealthType = "steps" | "distance" | "activeEnergy"

/** A bucket of sum(): `hour` 60 minutes, `day` a calendar day of the device's time zone (23 or 25
 *  hours where the clock changes). */
export type HealthBucket = "hour" | "day"

export interface HealthRange {
  /** The start, ms since the epoch. */
  from: f64
  /** The end (excluded), ms since the epoch; after `from`. */
  to: f64
  /** One row per bucket, consecutive from `from` — the last one ends at `to`. Without it, one row for
   *  the whole range. At most 10000 buckets, counting a day as 24 hours (a year by the hour). */
  bucket?: HealthBucket
}

/** One row of sum(): a period and its total. */
export interface HealthTotal {
  /** ms since the epoch. */
  start: f64
  /** ms since the epoch (excluded). */
  end: f64
  /** The total in the type's unit; 0 where nothing was recorded. */
  value: f64
}

export interface HealthParams {}

export interface HealthEvents {}

export interface Health extends Service<"health", HealthParams, HealthEvents> {
  /** Whether the device has the store: HealthKit's data on this device (an iPhone; an iPad from
   *  iPadOS 17), Health Connect installed and usable on Android (built into Android 14+; an app
   *  from Google Play on Android 9-13). Never prompts. */
  available(): Promise<boolean>
  /** Show the store's sheet that asks to READ `types`, where the store still has something to ask:
   *  iOS shows none for types it asked about before, Android none when every type is granted (a
   *  refused one may be asked again — Health Connect stops showing it after two refusals). Resolves
   *  when the sheet is done, and does not say what the person chose (iOS cannot know; on Android
   *  sum() tells).
   *  `unavailable`: no store (available() is false). `failed`: the sheet could not be shown (no
   *  activity, the app in the background), or the app is not set up for the store (iOS: without
   *  the HealthKit entitlement).
   *  @rejects unavailable failed */
  request(types: HealthType[]): Promise<void>
  /** The total of `type` over `range`, de-duplicated across sources — one row, or a row per bucket
   *  (0 where nothing was recorded, so a chart needs no gap logic).
   *  `denied`: reading `type` is not granted — on Android whenever it is not (refused, or never
   *  asked for); on iOS only for a type request() never asked about, as a refused one resolves
   *  zeros there. `unavailable`: no store. `failed`: the store refused the query (the device is
   *  locked, a quota of Health Connect, the app in the background on Android).
   *  Android reads the 30 days before the first grant and later only (Health Connect's history
   *  rule): earlier buckets are zeros.
   *  @rejects unavailable denied failed */
  sum(type: HealthType, range: HealthRange): Promise<HealthTotal[]>
}
