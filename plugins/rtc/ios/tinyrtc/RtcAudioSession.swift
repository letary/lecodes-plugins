// The ONE place this half touches AVAudioSession.

import AVFAudio
import Foundation

/// The app's audio session as a call needs it: play and record, voice chat (the OS's echo
/// canceller, noise suppression and gain), Bluetooth headsets allowed, earpiece or speaker.
///
/// An app with its own audio takes it over with `isManagedByApp = true` (before the first call):
/// tinyrtc then never sets the category, the mode, the route or the activation, and only runs its
/// audio unit; the app keeps the session `.playAndRecord` and active while a call runs. Interruptions
/// and resets are still followed (the unit stops and comes back with the session).
public final class RtcAudioSession: @unchecked Sendable {
    public static let shared = RtcAudioSession()

    public struct Configuration {
        public var category: AVAudioSession.Category = .playAndRecord
        public var mode: AVAudioSession.Mode = .voiceChat
        public var options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP]
        /// The core runs at 48 kHz; the unit converts from whatever the hardware runs at.
        public var preferredSampleRate: Double = 48_000
        public var preferredIOBufferDuration: TimeInterval = 0.01

        public init() {}
    }

    private struct State {
        var managedByApp = false
        var configuration = Configuration()
        var output = RtcAudioOutput.earpiece
        var active = false
        /// What the session was set to when a call took it: given back when the call lets go.
        var previous: Previous?
    }

    private struct Previous {
        let category: AVAudioSession.Category
        let mode: AVAudioSession.Mode
        let options: AVAudioSession.CategoryOptions
    }
    private let state = Locked(State())

    /// tinyrtc never configures or activates the session: the app does.
    public var isManagedByApp: Bool {
        get { state.read { $0.managedByApp } }
        set { state.write { $0.managedByApp = newValue } }
    }

    /// What `activate` sets (not used when the app manages the session).
    public var configuration: Configuration {
        get { state.read { $0.configuration } }
        set { state.write { $0.configuration = newValue } }
    }

    private init() {}

    var session: AVAudioSession { AVAudioSession.sharedInstance() }

    /// The rate the hardware runs at now.
    var hardwareSampleRate: Double { session.sampleRate }

    var hasRecordPermission: Bool {
        if #available(iOS 17.0, *) {
            return AVAudioApplication.shared.recordPermission == .granted
        } else {
            return session.recordPermission == .granted
        }
    }

    // MARK: on the audio queue (setActive and setCategory can block)

    func activate() throws {
        let (managed, configuration, output) = state.read { ($0.managedByApp, $0.configuration, $0.output) }
        guard !managed else { return }
        let session = session
        // The session is the app's too (a player, a recorder): remember how it was found.
        let found = Previous(category: session.category, mode: session.mode, options: session.categoryOptions)
        state.write { state in
            if !state.active { state.previous = found }
        }
        do {
            try session.setCategory(configuration.category, mode: configuration.mode, options: configuration.options)
            try? session.setPreferredSampleRate(configuration.preferredSampleRate)
            try? session.setPreferredIOBufferDuration(configuration.preferredIOBufferDuration)
            try session.setActive(true)
            try? session.overrideOutputAudioPort(output == .speaker ? .speaker : .none)
            state.write { $0.active = true }
        } catch {
            throw RtcError.failed("the audio session: \(error.localizedDescription)")
        }
    }

    func deactivate() {
        let (managed, active) = state.read { ($0.managedByApp, $0.active) }
        guard !managed, active else { return }
        let previous = state.write { state -> Previous? in
            state.active = false
            defer { state.previous = nil }
            return state.previous
        }
        // An app that never set its session up (the default category) has no other sound of its
        // own: the session is let go, and other apps' music comes back. An app that had set one up
        // has a player or a recorder of its own on it: deactivating would stop that too, so the
        // session stays active and gets its category back.
        if let previous, previous.category != .soloAmbient {
            try? session.setCategory(previous.category, mode: previous.mode, options: previous.options)
        } else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    func setOutput(_ output: RtcAudioOutput) {
        let (managed, active) = state.write { state -> (Bool, Bool) in
            state.output = output
            return (state.managedByApp, state.active)
        }
        guard !managed, active else { return }
        try? session.overrideOutputAudioPort(output == .speaker ? .speaker : .none)
    }

    var output: RtcAudioOutput { state.read { $0.output } }

    /// The session's notifications, to `queue`.
    func observe(on queue: DispatchQueue,
                 interruption: @escaping @Sendable (_ began: Bool) -> Void,
                 routeChange: @escaping @Sendable () -> Void,
                 reset: @escaping @Sendable () -> Void) -> [NSObjectProtocol] {
        let center = NotificationCenter.default
        let session = session
        return [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { note in
                guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
                // A late "began" for an app that was suspended meanwhile: nothing to stop.
                if type == .began, let reason = note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt,
                   reason == AVAudioSession.InterruptionReason.appWasSuspended.rawValue {
                    return
                }
                queue.async { interruption(type == .began) }
            },
            center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { _ in
                queue.async { routeChange() }
            },
            center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { _ in
                queue.async { reset() }
            },
        ]
    }

    /// The input and output ports, for `RtcEngine.devices()`.
    var ports: [RtcDevice] {
        let session = session
        var devices = (session.availableInputs ?? []).map {
            RtcDevice(id: $0.uid, kind: .microphone, label: $0.portName)
        }
        devices += session.currentRoute.outputs.map {
            RtcDevice(id: $0.uid, kind: .speaker, label: $0.portName)
        }
        return devices
    }
}
