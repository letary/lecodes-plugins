//
//  GeolocationService.swift — lecodes-plugins/geolocation
//
//  The "geolocation" service over CoreLocation. The channel (the calls, GeoOptions, GeoPosition,
//  the codes) is Geolocation.gen.swift, generated from contract.d.ts.
//
//  The session opens cheaply. The OS permission is the contract's (`@permission location`): the
//  generated glue asks the host before a call reaches here, so a call arrives authorized. The
//  Info.plist usage string (NSLocationWhenInUseUsageDescription) comes from the plugin's manifest.
//

import Foundation
import CoreLocation
import LeCodes

public final class GeolocationService: NSObject, GeolocationPlugin, CLLocationManagerDelegate {

    typealias Fix = Reply<GeoPosition, GeolocationCode>

    private let events: GeolocationEvents
    private lazy var manager: CLLocationManager = {
        let m = CLLocationManager()
        m.delegate = self
        return m
    }()

    private var watching = false
    private var singleFixes: [(reply: Fix, timer: Timer?)] = []

    init(_ events: GeolocationEvents) {
        self.events = events
        super.init()
    }

    public func getCurrent(_ options: GeoOptions?, _ reply: Reply<GeoPosition, GeolocationCode>) {
        requestSingleFix(options, reply)
    }

    public func startWatch(_ options: GeoOptions?, _ reply: Reply<Void, GeolocationCode>) {
        // A second call while watching keeps the first call's options (the contract's rule).
        if !watching {
            manager.desiredAccuracy = Self.accuracy(options)
            manager.startUpdatingLocation()
            watching = true
        }
        reply.resolve()
    }

    public func stopWatch(_ reply: Reply<Void, GeolocationCode>) {
        watching = false
        manager.stopUpdatingLocation()
        reply.resolve()
    }

    public func close() {
        watching = false
        manager.stopUpdatingLocation()
        for pending in singleFixes {
            pending.timer?.invalidate()
            pending.reply.reject(.unavailable)
        }
        singleFixes.removeAll()
    }

    // MARK: - Fixes

    private func requestSingleFix(_ options: GeoOptions?, _ reply: Fix) {
        manager.desiredAccuracy = Self.accuracy(options)

        var timer: Timer? = nil
        if let timeout = options?.timeout, timeout > 0 {
            timer = Timer.scheduledTimer(withTimeInterval: timeout / 1000, repeats: false) { [weak self] _ in
                guard let self else { return }
                self.singleFixes.removeAll { $0.reply === reply }
                reply.reject(.timeout)
            }
        }
        singleFixes.append((reply, timer))
        manager.requestLocation()
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let position = Self.position(location)

        let pending = singleFixes
        singleFixes.removeAll()
        for (reply, timer) in pending {
            timer?.invalidate()
            reply.resolve(position)
        }

        if watching {
            events.position(position)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let pending = singleFixes
        singleFixes.removeAll()
        let code: GeolocationCode = (error as? CLError)?.code == .denied ? .denied : .unavailable
        for (reply, timer) in pending {
            timer?.invalidate()
            reply.reject(code)
        }
    }

    // MARK: - Mapping

    private static func accuracy(_ options: GeoOptions?) -> CLLocationAccuracy {
        options?.highAccuracy == true ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
    }

    private static func position(_ location: CLLocation) -> GeoPosition {
        GeoPosition(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracy: location.horizontalAccuracy,
            altitude: location.verticalAccuracy >= 0 ? location.altitude : nil,
            heading: location.course >= 0 ? location.course : nil,
            speed: location.speed >= 0 ? location.speed : nil,
            timestamp: location.timestamp.timeIntervalSince1970 * 1000
        )
    }
}
