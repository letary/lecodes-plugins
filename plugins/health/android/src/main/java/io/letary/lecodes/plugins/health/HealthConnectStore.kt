//
//  HealthConnectStore.kt — lecodes-plugins/health
//
//  Health Connect, as the "health" service reads it: the client, the table of the contract's types
//  and the totals. Every total is an aggregate of Health Connect's own — de-duplicated across the
//  apps and devices that wrote the records (the phone and the watch count one walk once) — never a
//  sum of records. No bucket: aggregate() over the range. "hour": aggregateGroupByDuration, an hour
//  from `from`. "day": aggregateGroupByPeriod over LocalDateTime — a calendar day of the device's
//  time zone (23 or 25 hours where the clock changes; Health Connect places each record by the
//  local time it was recorded at).
//
//  The rows are the buckets this file counts; each group Health Connect answers is added to the
//  bucket that holds its middle (not matched by its start: a store that rounds a time would leave
//  a bucket empty). A bucket without data is a row of 0, whatever the store left out. Long ranges are
//  asked in chunks of CHUNK buckets, one request each.
//
//  Health Connect's calls are suspend functions; HealthService runs them. The library is minSdk 26:
//  nothing here is touched below it (HealthService checks the level first).
//

package io.letary.lecodes.plugins.health

import android.content.Context
import android.os.Build
import androidx.activity.result.contract.ActivityResultContract
import androidx.annotation.RequiresApi
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.aggregate.AggregationResult
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateGroupByDurationRequest
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.Period
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import kotlin.reflect.KClass

@RequiresApi(Build.VERSION_CODES.O)
internal class HealthConnectStore(context: Context) {

    /** Throws where Health Connect is not there: made after `available`. */
    private val client: HealthConnectClient = HealthConnectClient.getOrCreate(context)

    /** The store's permission sheet, as an activity result: the permissions to ask → those granted.
     *  The Health Connect app's screen on Android 9-13, the system's on 14+. */
    val sheet: ActivityResultContract<Set<String>, Set<String>> = PermissionController.createRequestPermissionResultContract()

    /** A type of the contract → its record, the aggregate of its total and that total in the
     *  contract's unit. A type added to the contract is a row here (and a READ permission in the
     *  manifest). */
    private class Kind(val record: KClass<out Record>, val metric: AggregateMetric<*>, val value: (AggregationResult) -> Double)

    private fun kind(type: HealthType): Kind = when (type) {
        HealthType.STEPS -> Kind(StepsRecord::class, StepsRecord.COUNT_TOTAL) {
            (it[StepsRecord.COUNT_TOTAL] ?: 0L).toDouble()
        }
        HealthType.DISTANCE -> Kind(DistanceRecord::class, DistanceRecord.DISTANCE_TOTAL) {
            it[DistanceRecord.DISTANCE_TOTAL]?.inMeters ?: 0.0
        }
        HealthType.ACTIVE_ENERGY -> Kind(ActiveCaloriesBurnedRecord::class, ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL) {
            it[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories ?: 0.0
        }
    }

    /** The READ permission of a type, as the manifest declares it (android.permission.health.READ_STEPS, …). */
    fun permission(type: HealthType): String = HealthPermission.getReadPermission(kind(type).record)

    suspend fun granted(): Set<String> = client.permissionController.getGrantedPermissions()

    /** The rows of sum(); the range is the caller's to check (`from` before `to`, at most MAX_BUCKETS). */
    suspend fun sum(type: HealthType, range: HealthRange): List<HealthTotal> {
        val kind = kind(type)
        val metrics = setOf(kind.metric)
        return when (range.bucket) {
            null -> {
                val result = client.aggregate(AggregateRequest(metrics, TimeRangeFilter.between(instant(range.from), instant(range.to))))
                listOf(HealthTotal(range.from, range.to, kind.value(result)))
            }
            HealthBucket.HOUR -> {
                val edges = hourEdges(range)
                val totals = DoubleArray(edges.size - 1)
                for (chunk in chunks(totals.size)) {
                    val filter = TimeRangeFilter.between(instant(edges[chunk.first]), instant(edges[chunk.last + 1]))
                    for (group in client.aggregateGroupByDuration(AggregateGroupByDurationRequest(metrics, filter, Duration.ofHours(1)))) {
                        val b = bucketOf(edges, (group.startTime.toEpochMilli() + group.endTime.toEpochMilli()) / 2.0)
                        if (b >= 0) totals[b] += kind.value(group.result)
                    }
                }
                rows(edges, totals)
            }
            HealthBucket.DAY -> {
                // Each bucket's start twice: as the wall clock reads it (what the request and its groups
                // are in) and as the instant of the row. A start in a gap of the clock (a day starting
                // at an hour that does not exist) is the first instant after it.
                val zone = ZoneId.systemDefault()
                val start = ZonedDateTime.ofInstant(instant(range.from), zone)
                val end = instant(range.to)
                val local = ArrayList<LocalDateTime>()
                val edges = ArrayList<Double>()
                var i = 0L
                while (true) {
                    val at = start.plusDays(i)
                    if (i > 0 && !at.toInstant().isBefore(end)) break
                    local.add(start.toLocalDateTime().plusDays(i))
                    edges.add(if (i == 0L) range.from else at.toInstant().toEpochMilli().toDouble())
                    i++
                }
                // `to` in the hour a clock turned back repeats may read earlier than the last start.
                val last = LocalDateTime.ofInstant(end, zone)
                local.add(if (last.isAfter(local.last())) last else local.last().plusSeconds(1))
                edges.add(range.to)

                val wall = local.map { wallMs(it) }
                val totals = DoubleArray(edges.size - 1)
                for (chunk in chunks(totals.size)) {
                    val filter = TimeRangeFilter.between(local[chunk.first], local[chunk.last + 1])
                    for (group in client.aggregateGroupByPeriod(AggregateGroupByPeriodRequest(metrics, filter, Period.ofDays(1)))) {
                        val b = bucketOf(wall, (wallMs(group.startTime) + wallMs(group.endTime)) / 2)
                        if (b >= 0) totals[b] += kind.value(group.result)
                    }
                }
                rows(edges, totals)
            }
        }
    }

    /** `from`, an hour after it, …, then `to`. */
    private fun hourEdges(range: HealthRange): List<Double> {
        val edges = ArrayList<Double>()
        var i = 0L
        while (true) {
            val at = range.from + i * HOUR_MS
            if (i > 0 && at >= range.to) break
            edges.add(at)
            i++
        }
        edges.add(range.to)
        return edges
    }

    private fun rows(edges: List<Double>, totals: DoubleArray): List<HealthTotal> =
        totals.indices.map { HealthTotal(edges[it], edges[it + 1], totals[it]) }

    /** The bucket of `edges` (ascending: the buckets' starts, then the end) that holds `at`; -1 outside. */
    private fun bucketOf(edges: List<Double>, at: Double): Int {
        if (at < edges.first() || at >= edges.last()) return -1
        var lo = 0
        var hi = edges.size - 2
        while (lo < hi) {   // the last start at or before `at`
            val mid = (lo + hi + 1) ushr 1
            if (edges[mid] <= at) lo = mid else hi = mid - 1
        }
        return lo
    }

    /** The buckets 0 until `count` in runs of CHUNK: one request each. */
    private fun chunks(count: Int): List<IntRange> = (0 until count step CHUNK).map { it until minOf(it + CHUNK, count) }

    private fun instant(ms: Double): Instant = Instant.ofEpochMilli(Math.round(ms))

    /** A wall-clock time as a number that orders like it: ms, read as if the clock were UTC's. */
    private fun wallMs(t: LocalDateTime): Double = t.toEpochSecond(ZoneOffset.UTC) * 1000.0 + t.nano / 1_000_000.0

    companion object {
        private const val HOUR_MS = 3_600_000.0
        /** Buckets per request: far below anything a request of Health Connect is held to. */
        private const val CHUNK = 500

        /** Health Connect is installed and usable: built into Android 14+, the app from Google Play
         *  (and new enough) on Android 9-13. */
        fun available(context: Context): Boolean =
            HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE
    }
}
