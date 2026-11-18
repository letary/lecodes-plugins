//
//  TorchService.swift — lecodes-plugins/torch
//
//  One session of the "torch" service over AVCaptureDevice's torch: the back wide camera's (every
//  iPhone's flash), else the first camera that has one. The channel (the calls, TorchInfo,
//  TorchState, the codes) is Torch.gen.swift, generated from contract.d.ts.
//
//  No permission, no NSCameraUsageDescription: the device is looked up and configured, never opened
//  as a capture input. The simulator has no camera: info() answers `available: false` there and
//  set() rejects "unavailable".
//
//  A level of 1 asks for AVCaptureDevice.maxAvailableTorchLevel — what the LED can give now (less
//  than 1 when it is warm); a level a warm LED cannot give lights it at what it can. set() answers
//  with what was asked; the device settles a moment later, and `change` (KVO on isTorchActive and
//  torchLevel, while the app listens) carries what it settled at. Calls arrive on the main thread,
//  KVO on any: `change` is sent from where it comes.
//

import AVFoundation
import Foundation
import LeCodes

public final class TorchService: TorchPlugin {

    private let events: TorchEvents
    /// The torch's device, looked up at the first call (a lookup prompts nothing, but is not free).
    private lazy var device: AVCaptureDevice? = TorchService.findTorch()
    /// The level this session last lit the torch at (nil: the default): what toggle() lights again.
    private var lastLevel: Float?
    private var observations: [NSKeyValueObservation] = []
    private let lock = NSLock()
    private var lastSent: TorchState?

    public init(_ events: TorchEvents) {
        self.events = events
    }

    private static func findTorch() -> AVCaptureDevice? {
        if let back = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back), back.hasTorch {
            return back
        }
        let kinds: [AVCaptureDevice.DeviceType] = [
            .builtInWideAngleCamera, .builtInDualCamera, .builtInDualWideCamera, .builtInTripleCamera,
            .builtInTelephotoCamera, .builtInUltraWideCamera,
        ]
        return AVCaptureDevice.DiscoverySession(deviceTypes: kinds, mediaType: .video, position: .unspecified)
            .devices.first { $0.hasTorch }
    }

    private static func state(of device: AVCaptureDevice) -> TorchState {
        let on = device.isTorchActive
        return TorchState(on: on, level: on ? Double(device.torchLevel) : 0)
    }

    // MARK: - Calls

    public func info(_ reply: Reply<TorchInfo, TorchCode>) {
        let has = device?.hasTorch ?? false
        reply.resolve(TorchInfo(available: has, dimmable: has))
    }

    public func state(_ reply: Reply<TorchState, TorchCode>) {
        guard let device else { return reply.resolve(TorchState(on: false, level: 0)) }
        reply.resolve(Self.state(of: device))
    }

    public func set(_ on: Bool, _ level: Double?, _ reply: Reply<TorchState, TorchCode>) {
        light(on && (level ?? 1) > 0, level.map { Float(min($0, 1)) }, reply)
    }

    public func toggle(_ reply: Reply<TorchState, TorchCode>) {
        guard let device else { return reply.reject(.unavailable) }
        light(!device.isTorchActive, lastLevel, reply)
    }

    /// Light the torch at `level` (nil: full), or turn it off.
    private func light(_ on: Bool, _ level: Float?, _ reply: Reply<TorchState, TorchCode>) {
        guard let device, device.hasTorch else { return reply.reject(.unavailable) }
        if on && !device.isTorchAvailable { return reply.reject(.unavailable) }   // the LED is too hot
        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            guard on else {
                device.torchMode = .off
                return reply.resolve(TorchState(on: false, level: 0))
            }
            let wanted = level ?? 1
            do {
                try device.setTorchModeOn(level: wanted >= 1 ? AVCaptureDevice.maxAvailableTorchLevel : wanted)
            } catch {
                // More than a warm LED can give: light it at what it can.
                try device.setTorchModeOn(level: AVCaptureDevice.maxAvailableTorchLevel)
            }
            lastLevel = level
            reply.resolve(TorchState(on: true, level: Double(min(wanted, 1))))
        } catch {
            if !device.isTorchAvailable { return reply.reject(.unavailable) }
            reply.reject(.failed)
        }
    }

    // MARK: - The change event

    public func changeObserved(_ observed: Bool) {
        if observed { observe() } else { stopObserving() }
    }

    private func observe() {
        guard observations.isEmpty, let device else { return }
        let send: (AVCaptureDevice) -> Void = { [weak self] d in self?.send(Self.state(of: d)) }
        observations = [
            device.observe(\.isTorchActive, options: [.new]) { d, _ in send(d) },
            device.observe(\.torchLevel, options: [.new]) { d, _ in send(d) },
        ]
    }

    private func stopObserving() {
        observations.forEach { $0.invalidate() }
        observations = []
        lock.lock(); lastSent = nil; lock.unlock()
    }

    /// One `change` per state the torch is in: isTorchActive and torchLevel move together.
    private func send(_ state: TorchState) {
        lock.lock()
        let same = lastSent.map { $0.on == state.on && abs($0.level - state.level) < 0.001 } ?? false
        if !same { lastSent = state }
        lock.unlock()
        if !same { events.change(state) }
    }

    public func close() { stopObserving() }
}
