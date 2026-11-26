// The camera: an AVCaptureSession configured on its own serial queue, delivering the sensor's
// buffers (never rotated) to the encoder's queue, with the rotation that shows them upright.
//
// Rotation: iOS 17+ asks AVCaptureDevice.RotationCoordinator (it knows the camera's mounting and
// the device's orientation); before, the device orientation and the camera's position give it, as
// libwebrtc's camera capturer does. Face up / down / unknown keep the last value.
//
// The OS taking the camera: an interruption (a call, another app, the background, system pressure)
// pauses the session and it resumes by itself — iOS's API is pause / resume. A runtime error after
// a media services reset restarts it; any other runtime error, or the camera disconnected, ends the
// track.

import AVFoundation
import CoreMedia
import UIKit

final class CameraCapturer: NSObject, VideoCapturer, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "tinyrtc.camera")
    private let output = AVCaptureVideoDataOutput()

    // On sessionQueue:
    private var input: AVCaptureDeviceInput?
    private var stopped = false
    private var observers: [NSObjectProtocol] = []

    private weak var encoder: H264Encoder?
    /// Degrees clockwise to show the buffers upright, read with every frame.
    private let rotation = Locked<UInt16>(90)
    private let ended = Locked<(@Sendable () -> Void)?>(nil)
    private let current = Locked<AVCaptureDevice?>(nil)
    /// iOS 17+: an AVCaptureDevice.RotationCoordinator and its observation.
    private let coordinator = Locked<(NSObject, NSKeyValueObservation)?>(nil)
    /// Before iOS 17: the device's orientation, kept by the main thread.
    private let orientation: Locked<UIDeviceOrientation>

    var onEnded: (@Sendable () -> Void)? {
        get { ended.get }
        set { ended.write { $0 = newValue } }
    }

    var previewSession: AVCaptureSession? { session }
    var device: AVCaptureDevice? { current.get }

    @MainActor
    static func make() -> CameraCapturer {
        CameraCapturer(orientation: DeviceOrientation.shared.value)
    }

    private init(orientation: Locked<UIDeviceOrientation>) {
        self.orientation = orientation
        super.init()
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    // MARK: devices

    static var cameras: [AVCaptureDevice] {
        var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera, .builtInUltraWideCamera, .builtInTelephotoCamera]
        if #available(iOS 17.0, *) { types.append(.external) }
        return AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified).devices
    }

    static func find(_ options: CameraOptions) -> AVCaptureDevice? {
        if let id = options.deviceId { return AVCaptureDevice(uniqueID: id) }
        let position: AVCaptureDevice.Position = options.facing == .user ? .front : .back
        return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
            ?? cameras.first { $0.position == position }
    }

    static func facing(of device: AVCaptureDevice) -> CameraFacing {
        device.position == .front ? .user : .environment
    }

    /// The format closest to the size asked for (either orientation), able to run at the rate.
    static func format(for device: AVCaptureDevice, width: Int, height: Int, frameRate: Int) -> AVCaptureDevice.Format? {
        let (wantLong, wantShort) = (max(width, height), min(width, height))
        var best: (score: Int, format: AVCaptureDevice.Format)?
        for format in device.formats {
            let subtype = CMFormatDescriptionGetMediaSubType(format.formatDescription)
            guard subtype == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || subtype == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange else {
                continue
            }
            let d = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let (long, short) = (Int(max(d.width, d.height)), Int(min(d.width, d.height)))
            var score = abs(long - wantLong) + abs(short - wantShort)
            let maxRate = format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0
            if maxRate + 0.5 < Double(frameRate) { score += 100_000 }
            // Video range is what an H.264 decoder assumes without looking at the VUI.
            if subtype == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange { score += 1 }
            if best.map({ score < $0.score }) ?? true { best = (score, format) }
        }
        return best?.format
    }

    // MARK: VideoCapturer

    func start(_ options: CameraOptions, into encoder: H264Encoder) async throws -> CameraSettings {
        // AVCaptureDevice is not Sendable; it is only configured on the session queue.
        guard let found = Self.find(options) else { throw RtcError.notFound }
        let device = Unchecked(value: found)
        self.encoder = encoder
        let settings = try await sessionQueue.run { [self] in
            session.beginConfiguration()
            defer { session.commitConfiguration() }
            let settings = try use(device.value, options)
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(self, queue: encoder.queue)
            guard session.canAddOutput(output) else { throw RtcError.failed("the camera output cannot be added") }
            session.addOutput(output)
            fixConnection()
            watch()
            return settings
        }
        // startRunning blocks (hundreds of ms): on the session queue, after the configuration.
        try await sessionQueue.run { [self] in
            if !stopped { session.startRunning() }
        }
        return settings
    }

    func apply(_ options: CameraOptions) async throws -> CameraSettings {
        guard let found = Self.find(options) else { throw RtcError.notFound }
        let device = Unchecked(value: found)
        return try await sessionQueue.run { [self] in
            guard !stopped else { throw RtcError.closed }
            session.beginConfiguration()
            defer { session.commitConfiguration() }
            let settings = try use(device.value, options)
            fixConnection()
            return settings
        }
    }

    func stop() async {
        _ = try? await sessionQueue.run { [self] in
            guard !stopped else { return }
            stopped = true
            output.setSampleBufferDelegate(nil, queue: nil)
            session.stopRunning()
            session.beginConfiguration()
            session.inputs.forEach(session.removeInput)
            session.outputs.forEach(session.removeOutput)
            session.commitConfiguration()
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers = []
            coordinator.write { $0 = nil }
        }
    }

    // MARK: on sessionQueue

    /// `device` as the session's input, at the format closest to `options`.
    private func use(_ device: AVCaptureDevice, _ options: CameraOptions) throws -> CameraSettings {
        if input?.device != device {
            if let input { session.removeInput(input) }
            let made: AVCaptureDeviceInput
            do {
                made = try AVCaptureDeviceInput(device: device)
            } catch {
                throw RtcError.failed("the camera cannot be opened: \(error.localizedDescription)")
            }
            guard session.canAddInput(made) else { throw RtcError.failed("the camera cannot be added to the session") }
            session.addInput(made)
            input = made
            current.write { $0 = device }
            watchRotation(device)
        }
        guard let format = Self.format(for: device, width: options.width, height: options.height, frameRate: options.frameRate) else {
            throw RtcError.notFound
        }
        let ranges = format.videoSupportedFrameRateRanges
        let top = ranges.map(\.maxFrameRate).max() ?? Double(options.frameRate)
        let rate = max(1, min(Double(options.frameRate), top))
        do {
            try device.lockForConfiguration()
            device.activeFormat = format
            let duration = CMTime(value: 1, timescale: CMTimeScale(rate.rounded()))
            if ranges.contains(where: { $0.minFrameRate <= rate && rate <= $0.maxFrameRate }) {
                device.activeVideoMinFrameDuration = duration
                device.activeVideoMaxFrameDuration = duration
            }
            device.unlockForConfiguration()
        } catch {
            throw RtcError.failed("the camera cannot be configured: \(error.localizedDescription)")
        }
        let subtype = CMFormatDescriptionGetMediaSubType(format.formatDescription)
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: subtype]
        let d = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        return CameraSettings(deviceId: device.uniqueID, facing: Self.facing(of: device),
                              width: Int(d.width), height: Int(d.height), frameRate: Int(rate.rounded()))
    }

    /// The buffers as the sensor gives them: not rotated, not mirrored.
    private func fixConnection() {
        guard let connection = output.connection(with: .video) else { return }
        if #available(iOS 17.0, *) {
            if connection.isVideoRotationAngleSupported(0) { connection.videoRotationAngle = 0 }
        } else if connection.isVideoOrientationSupported {
            connection.videoOrientation = .landscapeRight
        }
        if connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = false
        }
    }

    private func watch() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil) { note in
            log.info("camera interrupted: \(String(describing: note.userInfo?[AVCaptureSessionInterruptionReasonKey]), privacy: .public)")
        })
        observers.append(center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: nil) { _ in
            log.info("camera interruption ended")
        })
        observers.append(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
            let error = note.userInfo?[AVCaptureSessionErrorKey] as? AVError
            log.error("camera runtime error: \(String(describing: error), privacy: .public)")
            guard let self else { return }
            if error?.code == .mediaServicesWereReset {
                sessionQueue.async { if !self.stopped { self.session.startRunning() } }
            } else {
                ended.get?()
            }
        })
        observers.append(center.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil) { [weak self] note in
            guard let self, let device = note.object as? AVCaptureDevice, device == current.get else { return }
            ended.get?()
        })
    }

    private func watchRotation(_ device: AVCaptureDevice) {
        if #available(iOS 17.0, *) {
            let made = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil)
            let observation = made.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.initial, .new]) { [weak self] coordinator, _ in
                let degrees = Int(coordinator.videoRotationAngleForHorizonLevelCapture.rounded()) % 360
                self?.rotation.write { $0 = UInt16((degrees + 360) % 360) }
            }
            coordinator.write { $0 = (made, observation) }
        }
    }

    /// Before iOS 17: libwebrtc's table (RTCCameraVideoCapturer); face up / down keep the last value.
    private func legacyRotation() -> UInt16 {
        let front = current.get?.position == .front
        let degrees: UInt16?
        switch orientation.get {
        case .portrait: degrees = 90
        case .portraitUpsideDown: degrees = 270
        case .landscapeLeft: degrees = front ? 180 : 0
        case .landscapeRight: degrees = front ? 0 : 180
        default: degrees = nil
        }
        return rotation.write { last in
            if let degrees { last = degrees }
            return last
        }
    }

    // MARK: frames, on the encoder's queue

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let degrees: UInt16
        if #available(iOS 17.0, *) {
            degrees = rotation.get
        } else {
            degrees = legacyRotation()
        }
        encoder?.encode(pixelBuffer, time: CMSampleBufferGetPresentationTimeStamp(sampleBuffer), rotation: degrees)
    }
}

/// The device's orientation for the capture threads (before iOS 17). Kept by the main thread.
@MainActor
final class DeviceOrientation {
    static let shared = DeviceOrientation()
    let value = Locked<UIDeviceOrientation>(.portrait)
    private var observer: NSObjectProtocol?

    private init() {
        guard #unavailable(iOS 17.0) else { return }
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        observer = NotificationCenter.default.addObserver(forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main) { [value] _ in
            MainActor.assumeIsolated { value.write { $0 = UIDevice.current.orientation } }
        }
        value.write { $0 = UIDevice.current.orientation }
    }
}
