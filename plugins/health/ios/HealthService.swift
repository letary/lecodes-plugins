//
//  HealthService.swift — lecodes-plugins/health
//
//  The "health" service over HealthKit. The channel (the calls, HealthType, HealthRange,
//  HealthTotal, the codes) is Health.gen.swift, generated from contract.d.ts.
//
//  Read only, totals only: every sum is HealthKit's own statistics with `.cumulativeSum`, which
//  de-duplicates the sources (the iPhone and the Watch count one walk once) — never a sum of
//  samples. No bucket: one HKStatisticsQuery over the range. A bucket: one
//  HKStatisticsCollectionQuery anchored at `from` with an interval of an hour or of a calendar day
//  (DateComponents: the device's calendar and time zone, so a day is 23 or 25 hours where the clock
//  changes). The rows are the buckets this file counts (`edges`), each looked up in the collection by
//  the middle of its time — a bucket without data is a row of 0, whatever HealthKit left out.
//
//  HealthKit never tells an app whether it may READ a type: a refusal looks like no data, so a
//  refused type sums to zeros. Only a type the app never asked about is told apart
//  (errorAuthorizationNotDetermined → `denied`). An empty range is errorNoData — zeros too, not a
//  failure.
//
//  Calls arrive on the main thread; HealthKit answers on queues of its own and the reply is settled
//  there (a Reply may be settled from any thread). Nothing here is state but the one store.
//

import Foundation
import HealthKit
import LeCodes

public final class HealthService: HealthPlugin {

    /// The most rows one sum() answers — the wrapper's MAX_BUCKETS, counted the same way (a day as
    /// 24 hours).
    static let maxBuckets = 10_000

    /// One store for the app's life (Apple: make one and keep it); none where the device has no
    /// HealthKit data.
    private static let store: HKHealthStore? = HKHealthStore.isHealthDataAvailable() ? HKHealthStore() : nil

    public init() {}

    // MARK: - Calls

    public func available(_ reply: Reply<Bool, HealthCode>) {
        reply.resolve(HKHealthStore.isHealthDataAvailable())
    }

    public func request(_ types: [HealthType], _ reply: Reply<Void, HealthCode>) {
        guard let store = Self.store else { return reply.reject(.unavailable) }
        let read = Set(types.map { Self.kind($0).quantity as HKObjectType })
        guard !read.isEmpty else { return reply.resolve() }
        // The sheet lists the types HealthKit has not asked about yet (none: no sheet), and the
        // answer comes when it is done. `success` says the request was handled, never what the
        // person chose. Without the entitlement it is an error; without the usage string HealthKit
        // raises (the manifest carries both).
        store.requestAuthorization(toShare: [], read: read) { _, error in
            guard let error else { return reply.resolve() }
            NSLog("[health] request failed: %@", String(describing: error))
            reply.reject(HealthService.code(error) == .errorHealthDataUnavailable ? .unavailable : .failed)
        }
    }

    public func sum(_ type: HealthType, _ range: HealthRange, _ reply: Reply<[HealthTotal], HealthCode>) {
        // The wrapper refuses these before the wire; a call from elsewhere is said the same.
        guard range.from < range.to else { return reply.fail("Health.sum: range.from must be before range.to") }
        guard let store = Self.store else { return reply.reject(.unavailable) }
        let kind = Self.kind(type)
        let from = Self.date(range.from)
        // The samples that overlap the range (no strict start or end): the statistics take of each
        // the part inside the period they compute.
        let predicate = HKQuery.predicateForSamples(withStart: from, end: Self.date(range.to), options: [])

        guard let bucket = range.bucket else {
            let query = HKStatisticsQuery(quantityType: kind.quantity, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, statistics, error in
                if let error, HealthService.code(error) != .errorNoData { return HealthService.reject(reply, error) }
                let value = statistics?.sumQuantity()?.doubleValue(for: kind.unit) ?? 0
                reply.resolve([HealthTotal(start: range.from, end: range.to, value: value)])
            }
            return store.execute(query)
        }

        guard let edges = Self.edges(range, bucket) else {
            return reply.fail("Health.sum: more than \(Self.maxBuckets) buckets — a shorter range or a longer bucket")
        }
        let interval = bucket == .day ? DateComponents(day: 1) : DateComponents(hour: 1)
        let query = HKStatisticsCollectionQuery(quantityType: kind.quantity, quantitySamplePredicate: predicate,
                                                options: .cumulativeSum, anchorDate: from, intervalComponents: interval)
        // No statisticsUpdateHandler: the query stops once the initial results are in.
        query.initialResultsHandler = { _, collection, error in
            if let error, HealthService.code(error) != .errorNoData { return HealthService.reject(reply, error) }
            var rows: [HealthTotal] = []
            rows.reserveCapacity(edges.count - 1)
            for i in 0..<(edges.count - 1) {
                let start = edges[i], end = edges[i + 1]
                // HealthKit's interval that holds the middle of the bucket: the last bucket, cut at
                // `to`, is the start of a whole interval there.
                let middle = HealthService.date((start + end) / 2)
                let value = collection?.statistics(for: middle)?.sumQuantity()?.doubleValue(for: kind.unit) ?? 0
                rows.append(HealthTotal(start: start, end: end, value: value))
            }
            reply.resolve(rows)
        }
        store.execute(query)
    }

    // MARK: - The types

    /// A type of the contract → its HealthKit quantity and the contract's unit. A type added to the
    /// contract is a row here.
    private static func kind(_ type: HealthType) -> (quantity: HKQuantityType, unit: HKUnit) {
        switch type {
        case .steps: return (quantity(.stepCount), HKUnit.count())
        case .distance: return (quantity(.distanceWalkingRunning), HKUnit.meter())
        case .activeEnergy: return (quantity(.activeEnergyBurned), HKUnit.kilocalorie())
        }
    }

    private static func quantity(_ id: HKQuantityTypeIdentifier) -> HKQuantityType {
        HKObjectType.quantityType(forIdentifier: id)!   // nil only for an identifier HealthKit does not know
    }

    // MARK: - Buckets

    /// The buckets' edges in ms — `range.from` first, `range.to` last: an hour is 3600 s, a day the
    /// calendar's from `from` (what the collection query counts from its anchor). nil past
    /// maxBuckets.
    static func edges(_ range: HealthRange, _ bucket: HealthBucket) -> [Double]? {
        let length: Double = bucket == .hour ? 3_600_000 : 86_400_000
        guard ((range.to - range.from) / length).rounded(.up) <= Double(maxBuckets) else { return nil }
        let calendar = Calendar.current
        let from = date(range.from)
        var edges = [range.from]
        var i = 1
        while true {
            let next: Double
            switch bucket {
            case .hour:
                next = range.from + Double(i) * length
            case .day:
                guard let day = calendar.date(byAdding: .day, value: i, to: from) else { return nil }
                next = (day.timeIntervalSince1970 * 1000).rounded()
            }
            if next >= range.to {
                edges.append(range.to)
                return edges
            }
            edges.append(next)
            i += 1
        }
    }

    private static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    // MARK: - Errors

    private static func reject(_ reply: Reply<[HealthTotal], HealthCode>, _ error: Error) {
        switch code(error) {
        case .errorHealthDataUnavailable?, .errorHealthDataRestricted?:
            reply.reject(.unavailable)
        case .errorAuthorizationNotDetermined?, .errorAuthorizationDenied?:
            // Never asked about the type (request() was not called for it).
            reply.reject(.denied)
        default:
            // errorDatabaseInaccessible (the device is locked), …
            NSLog("[health] sum failed: %@", String(describing: error))
            reply.reject(.failed)
        }
    }

    /// The HealthKit code of an error, nil for another domain's.
    private static func code(_ error: Error) -> HKError.Code? {
        let ns = error as NSError
        guard ns.domain == HKErrorDomain else { return nil }
        return HKError.Code(rawValue: ns.code)
    }
}
