//
//  BiometricsService.swift — lecodes-plugins/biometrics
//
//  The "biometrics" service over LocalAuthentication. The channel (the calls, BiometricOptions,
//  BiometricStatus, the codes) is Biometrics.gen.swift, generated from contract.d.ts.
//
//  The policy is the option's: `.deviceOwnerAuthenticationWithBiometrics` (Face ID / Touch ID only;
//  the "Enter Password" button a failed attempt brings is hidden), or with allowPasscode
//  `.deviceOwnerAuthentication` (the passcode beside them, alone where none is enrolled or the
//  biometric is locked out). One dialog at a time: a call while one is up rejects "busy". The dialog
//  closing without a confirmation is not a failure — the call resolves with false.
//
//  The system shows the dialog itself (no window, no view controller of ours); evaluatePolicy
//  answers on a queue of its own, and the answer is taken back to the main thread, where the calls
//  arrive and the state lives.
//
//  The Face ID question ("Allow … to use Face ID?") is asked by the system at the first
//  evaluatePolicy, with the manifest's NSFaceIDUsageDescription. A refusal is
//  `biometryNotAvailable` from then on: status `available: false`, authenticate "unavailable" (the
//  passcode still works with allowPasscode).
//

import Foundation
import LocalAuthentication
import LeCodes

public final class BiometricsService: BiometricsPlugin {

    typealias Confirm = Reply<Bool, BiometricsCode>

    /// The call whose dialog is up, and the context that shows it (`invalidate()` takes it down).
    private var pending: Confirm?
    private var context: LAContext?

    public init() {}

    // MARK: - Calls

    public func status(_ reply: Reply<BiometricStatus, BiometricsCode>) {
        let context = LAContext()
        var error: NSError?
        let can = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        // Locked out is still a biometric the device has and the owner enrolled: authenticate() says
        // "lockout". biometryType is set by canEvaluatePolicy whatever it answers.
        let lockedOut = Self.code(error) == .biometryLockout
        reply.resolve(BiometricStatus(available: can || lockedOut, kind: Self.kind(context.biometryType)))
    }

    public func authenticate(_ options: BiometricOptions, _ reply: Reply<Bool, BiometricsCode>) {
        onMain {
            guard self.pending == nil else { return reply.reject(.busy) }
            // LocalAuthentication raises on an empty reason; the wrapper refuses one before the wire.
            guard !options.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return reply.fail("Biometrics.authenticate: a reason is required — the text the system's dialog shows")
            }

            let passcode = options.allowPasscode == true
            let policy: LAPolicy = passcode ? .deviceOwnerAuthentication : .deviceOwnerAuthenticationWithBiometrics
            let context = LAContext()
            // Biometrics alone: no fallback button after a failed attempt (an empty title hides it).
            if !passcode { context.localizedFallbackTitle = "" }

            var error: NSError?
            guard context.canEvaluatePolicy(policy, error: &error) else {
                return reply.reject(Self.rejection(Self.code(error)))
            }

            self.pending = reply
            self.context = context
            // Held strongly: the answer must reach the reply even if the session lets go of this
            // object first (close() settles it before that, the second settle is dropped).
            context.evaluatePolicy(policy, localizedReason: options.reason) { success, error in
                DispatchQueue.main.async { self.finish(context, success, error) }
            }
        }
    }

    public func close() {
        onMain {
            guard let reply = self.pending else { return }
            let context = self.context
            self.pending = nil
            self.context = nil
            context?.invalidate()   // the dialog goes; its own answer (appCancel) finds nothing pending
            reply.resolve(false)
        }
    }

    // MARK: - The answer

    private func finish(_ from: LAContext, _ success: Bool, _ error: Error?) {
        guard context === from, let reply = pending else { return }   // close() settled it
        pending = nil
        context = nil
        if success { return reply.resolve(true) }
        guard let code = Self.code(error) else {
            NSLog("[biometrics] authenticate failed: %@", String(describing: error))
            return reply.reject(.failed)
        }
        switch code {
        // The dialog closed without a confirmation: the person cancelled, the system or the app took
        // it down (the app went to the background), or the person chose the hidden fallback.
        case .userCancel, .systemCancel, .appCancel, .userFallback:
            reply.resolve(false)
        default:
            if code != .biometryLockout { NSLog("[biometrics] authenticate failed: %@", String(describing: error)) }
            reply.reject(Self.rejection(code))
        }
    }

    // MARK: - Mapping

    /// The LocalAuthentication code of an error, nil for another domain's (or none).
    private static func code(_ error: Error?) -> LAError.Code? {
        guard let error else { return nil }
        let ns = error as NSError
        guard ns.domain == LAErrorDomain else { return nil }
        return LAError.Code(rawValue: ns.code)
    }

    /// What a refusal (canEvaluatePolicy) or an ending (evaluatePolicy) that is not a cancel says.
    private static func rejection(_ code: LAError.Code?) -> BiometricsCode {
        guard let code else { return .failed }
        switch code {
        case .biometryLockout:
            return .lockout
        case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet:
            return .unavailable
        default:
            // authenticationFailed (not recognized: the dialog closes after a few attempts),
            // notInteractive (the app is not in front), invalidContext, …
            return .failed
        }
    }

    private static func kind(_ type: LABiometryType) -> BiometricKind {
        switch type {
        case .faceID: return .face
        case .touchID: return .fingerprint
        default: return .unknown   // .none; .opticID is visionOS'
        }
    }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }
}
