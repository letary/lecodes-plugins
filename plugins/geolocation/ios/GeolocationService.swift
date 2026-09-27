//
//  GeolocationService.swift — lecodes-plugins/geolocation
//
//  The "geolocation" service over CoreLocation. The channel (the calls, GeoOptions, GeoPosition,
//  the codes) is Geolocation.gen.swift, generated from contract.d.ts.
//
//  The session opens cheaply; the OS permission prompt fires on the first call that needs a fix.
//  The Info.plist usage string (NSLocationWhenInUseUsageDescription) comes from the plugin's
//  manifest — the host app must ship it or the prompt never appears.
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

    /// Calls parked until the user answers the permission prompt.
    private var pendingAuthorization: [(Bool) -> Void] = []
    private var watching = false
    private var singleFixes: [(reply: Fix, timer: Timer?)] = []

    init(_ events: GeolocationEvents) {
        self.events = events
        super.init()
    }

    public func getCurrent(_ options: GeoOptions?, _ reply: Reply<GeoPosition, GeolocationCode>) {
        withAuthorization { [weak self] granted in
            guard let self else { return reply.reject(.unavailable) }
            guard granted else { return reply.reject(.denied) }
            self.requestSingleFix(options, reply)
        }
    }

    public func startWatch(_ options: GeoOptions?, _ reply: Reply<Void, GeolocationCode>) {
        withAuthorization { [weak self] granted in
            guard let self else { return reply.reject(.unavailable) }
            guard granted else { return reply.reject(.denied) }
            // A second call while watching keeps the first call's options (the contract's rule).
            if !self.watching {
                self.manager.desiredAccuracy = Self.accuracy(options)
                self.manager.startUpdatingLocation()
                self.watching = true
            }
            reply.resolve()
        }
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

    // MARK: - Authorization

    private func withAuthorization(_ proceed: @escaping (Bool) -> Void) {
        switch authorizationStatus() {
        case .authorizedAlways, .authorizedWhenInUse:
            proceed(true)
        case .denied, .restricted:
            proceed(false)
        case .notDetermined:
            pendingAuthorization.append(proceed)
            manager.requestWhenInUseAuthorization()
        @unknown default:
            proceed(false)
        }
    }

    private func authorizationStatus() -> CLAuthorizationStatus {
        if #available(iOS 14.0, *) {
            return manager.authorizationStatus
        }
        return CLLocationManager.authorizationStatus()
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = authorizationStatus()
        guard status != .notDetermined, !pendingAuthorization.isEmpty else { return }
        let granted = status == .authorizedAlways || status == .authorizedWhenInUse
        let pending = pendingAuthorization
        pendingAuthorization.removeAll()
        pending.forEach { $0(granted) }
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
