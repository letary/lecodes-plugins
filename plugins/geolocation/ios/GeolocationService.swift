//
//  GeolocationService.swift — lecodes-plugins/geolocation
//
//  The "geolocation" service (docs/service-channel-plan.md) over CoreLocation.
//  Contract (mirrors the web host over navigator.geolocation):
//    call getCurrent({highAccuracy?, timeout?})  → GeoPosition; rejects "denied" / "unavailable" / "timeout"
//    call startWatch({highAccuracy?})            → resolves once watching; rejects "denied" / "unavailable"
//    call stopWatch()                            → resolves
//    event "position"                            → GeoPosition, per provider update while watching
//
//  GeoPosition: { latitude, longitude, accuracy, altitude|null, heading|null, speed|null, timestamp }.
//  The session opens cheaply; the OS permission prompt fires on the first call that needs
//  a fix. The Info.plist usage string (NSLocationWhenInUseUsageDescription) comes from
//  the plugin manifest — the host app must ship it or the prompt never appears.
//

import Foundation
import CoreLocation
import LeCodesSDK

public final class GeolocationService: NSObject, ServiceInstance, CLLocationManagerDelegate {

    private let channel: ServiceChannel
    private lazy var manager: CLLocationManager = {
        let m = CLLocationManager()
        m.delegate = self
        return m
    }()

    /// Calls parked until the user answers the permission prompt.
    private var pendingAuthorization: [(Bool) -> Void] = []
    private var watching = false
    private var singleFixSettles: [(settle: ChannelSettle, timer: Timer?)] = []

    public init(_ channel: ServiceChannel) {
        self.channel = channel
        super.init()
    }

    public func call(_ method: String, _ args: [Any], _ settle: ChannelSettle) {
        let options = args.first as? [String: Any]
        switch method {
        case "getCurrent":
            withAuthorization { [weak self] granted in
                guard let self else { return settle.reject("unavailable") }
                guard granted else { return settle.reject("denied") }
                self.requestSingleFix(options, settle)
            }
        case "startWatch":
            withAuthorization { [weak self] granted in
                guard let self else { return settle.reject("unavailable") }
                guard granted else { return settle.reject("denied") }
                self.manager.desiredAccuracy = Self.accuracy(options)
                self.manager.startUpdatingLocation()
                self.watching = true
                settle.resolve()
            }
        case "stopWatch":
            watching = false
            manager.stopUpdatingLocation()
            settle.resolve()
        default:
            settle.reject("Unknown method: \(method)")
        }
    }

    public func close() {
        watching = false
        manager.stopUpdatingLocation()
        for pending in singleFixSettles {
            pending.timer?.invalidate()
            pending.settle.reject("unavailable")
        }
        singleFixSettles.removeAll()
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

    private func requestSingleFix(_ options: [String: Any]?, _ settle: ChannelSettle) {
        manager.desiredAccuracy = Self.accuracy(options)

        var timer: Timer? = nil
        if let timeout = options?["timeout"] as? Double, timeout > 0 {
            timer = Timer.scheduledTimer(withTimeInterval: timeout / 1000, repeats: false) { [weak self] _ in
                guard let self else { return }
                self.singleFixSettles.removeAll { $0.settle === settle }
                settle.reject("timeout")
            }
        }
        singleFixSettles.append((settle, timer))
        manager.requestLocation()
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let position = Self.position(location)

        let pending = singleFixSettles
        singleFixSettles.removeAll()
        for (settle, timer) in pending {
            timer?.invalidate()
            settle.resolve(position)
        }

        if watching {
            channel.emit("position", position)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let pending = singleFixSettles
        singleFixSettles.removeAll()
        let message = (error as? CLError)?.code == .denied ? "denied" : "unavailable"
        for (settle, timer) in pending {
            timer?.invalidate()
            settle.reject(message)
        }
    }

    // MARK: - Mapping

    private static func accuracy(_ options: [String: Any]?) -> CLLocationAccuracy {
        (options?["highAccuracy"] as? Bool) == true ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
    }

    private static func position(_ location: CLLocation) -> [String: Any] {
        [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy,
            "altitude": location.verticalAccuracy >= 0 ? location.altitude : NSNull(),
            "heading": location.course >= 0 ? location.course : NSNull(),
            "speed": location.speed >= 0 ? location.speed : NSNull(),
            "timestamp": location.timestamp.timeIntervalSince1970 * 1000,
        ]
    }
}
