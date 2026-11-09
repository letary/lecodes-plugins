//
//  CameraPreview.swift — lecodes-plugins/camera
//
//  The ONE camera preview behind both surfaces of the plugin (contract.d.ts): the fullscreen view
//  "camera" (CameraViewInstance) and the host node "camera" (CameraNodeInstance, a box of a screen's
//  layout) each wrap a CameraPreview — the capture session, the preview layer (aspect-fill, clipped
//  to the view), the facing switch, the still capture. The surfaces differ only in WHEN the session
//  starts (CameraPlugin.swift says why): `start()` once, and from then on the session runs while the
//  view is in a window.
//
//  Threading: ALL AVCaptureSession work (configuration, startRunning, stopRunning,
//  facing-mode swaps, captures, teardown) happens on one serial `sessionQueue` — the same
//  contract as QRScannerView. AVFoundation blocks the calling thread for hardware
//  arbitration, so session setup or dealloc on the main thread freezes the UI for
//  seconds (touches queue up and replay when the camera stack settles). The shutdown
//  block captures the session strongly, so a world swap dropping the last reference
//  on the main thread never deallocates a running session there. The serial queue
//  also keeps start/stop/reconfigure/capture from racing each other: a capture asked
//  right after `start()` runs after the camera was attached.
//

import UIKit
import AVFoundation
import LeCodes

enum CameraFacingMode {
    case front
    case back

    var position: AVCaptureDevice.Position { self == .front ? .front : .back }
}

extension Optional where Wrapped == Facing {
    /// The contract's facing mode (absent = the back camera) as the preview's.
    var mode: CameraFacingMode { self == .front ? .front : .back }
}

/// The codes the camera's calls reject with — the contract's CameraMethods, the same for both
/// surfaces: each surface's generated enum has them as cases.
protocol CameraCode: PluginCode {
    static var failed: Self { get }
}
extension CameraViewCode: CameraCode {}
extension UICameraNodeCode: CameraCode {}

final class CameraPreview: UIView {

    // MARK: - Private

    private static let sessionQueue = DispatchQueue(label: "lecodes.camera.session", qos: .userInitiated)

    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var facingMode: CameraFacingMode
    /// `start()` ran: the camera is (being) attached, and the session runs while in a window.
    private var started = false
    private var didShutdown = false

    /// The preview could not start or stopped, as the app reads it (the contract's `error`). Main thread.
    var onError: ((String) -> Void)?

    // MARK: - Init

    init(facingMode: CameraFacingMode = .back) {
        self.facingMode = facingMode
        super.init(frame: .zero)
        // Aspect-fill overflows the layer: the preview never leaves the view's box.
        clipsToBounds = true
        // The preview layer is cheap and main-thread-bound; attach it now so layout
        // works immediately. It shows frames once the session starts on the queue.
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        // Bottom of the stack: overlays mount as subviews (their layers are sublayers
        // here), and the preview must never cover them regardless of mount timing.
        layer.insertSublayer(preview, at: 0)
        previewLayer = preview
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        // Last-resort teardown for a release without window removal (world swap drops
        // the plugin instance directly). The block keeps the session AND preview layer
        // alive until the stop completes, so both dealloc on the session queue — never
        // on main (preview-layer dealloc syncs with the capture pipeline; a collision
        // with an in-flight stop was measured blocking main for 9s in the QR twin).
        Self.stop(session, releasing: previewLayer)
    }

    // MARK: - Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer?.frame = bounds
    }

    // MARK: - Lifecycle

    /// Attach the camera of the facing mode written last and run the session while the view is in
    /// a window. Once; nothing after `shutdown()`.
    func start() {
        guard !started, !didShutdown else { return }
        started = true
        attach(facingMode.position)
        if window != nil { run() }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            guard started, !didShutdown else { return }
            run()
        } else {
            Self.stop(session)
        }
    }

    /// Explicit teardown (the instance's destroy). Idempotent; safe from the main thread — the
    /// stop, the session's dealloc, AND the preview layer's dealloc all happen on the
    /// session queue (both objects hold connections into the capture pipeline).
    func shutdown() {
        didShutdown = true
        onError = nil
        let preview = previewLayer
        preview?.removeFromSuperlayer()      // pure layer-tree detach — cheap on main
        previewLayer = nil
        Self.stop(session, releasing: preview)
    }

    private func run() {
        Self.sessionQueue.async { [session] in
            if !session.isRunning { session.startRunning() }
        }
    }

    private static func stop(_ session: AVCaptureSession, releasing preview: AVCaptureVideoPreviewLayer? = nil) {
        sessionQueue.async {
            if session.isRunning { session.stopRunning() }
            preview?.session = nil
            // The block's strong captures release the session and the preview layer
            // here, on the session queue.
        }
    }

    /// The session's input becomes the camera at `position` (and the photo output is there); a
    /// problem goes to `onError` on the main thread.
    private func attach(_ position: AVCaptureDevice.Position) {
        Self.sessionQueue.async { [session, photoOutput, weak self] in
            // Device lookup + input creation negotiate with the camera hardware — the
            // parts that block for hundreds of ms and must stay off the main thread.
            guard let problem = Self.attach(position, to: session, photoOutput) else { return }
            DispatchQueue.main.async { self?.onError?(problem) }
        }
    }

    /// On the session queue: what went wrong, nil when the camera is attached.
    private static func attach(_ position: AVCaptureDevice.Position, to session: AVCaptureSession, _ output: AVCapturePhotoOutput) -> String? {
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.inputs.forEach { session.removeInput($0) }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) else {
            return "no \(position == .front ? "front" : "back") camera on this device"
        }
        guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            return "the camera could not be opened"
        }
        session.addInput(input)
        if !session.outputs.contains(output) {
            guard session.canAddOutput(output) else { return "the camera cannot take photos" }
            session.addOutput(output)
        }
        return nil
    }

    // MARK: - Public

    /// Switch the camera; before `start()` it only picks the one `start()` attaches.
    func setFacingMode(_ facingMode: CameraFacingMode) {
        guard self.facingMode != facingMode else { return }
        self.facingMode = facingMode
        guard started, !didShutdown else { return }
        attach(facingMode.position)
    }

    /// The current frame, or nil when there is none to give (not started, no camera, stopped).
    /// Completes on a capture queue.
    func takePhoto(completion: @escaping (UIImage?) -> Void) {
        Self.sessionQueue.async { [photoOutput] in
            // A capture without a live video connection raises (an ObjC exception, not catchable).
            guard let connection = photoOutput.connection(with: .video), connection.isEnabled, connection.isActive else {
                return completion(nil)
            }
            let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            photoOutput.capturePhoto(with: settings, delegate: PhotoCapture(completion))
        }
    }

    /// `takePhoto` of both surfaces: the frame as a JPEG File, `failed` without one.
    func takePhoto<C: CameraCode>(_ reply: Reply<PluginFile, C>) {
        takePhoto { image in
            guard let image, let jpg = image.jpegData(compressionQuality: 0.95) else { return reply.reject(.failed) }
            reply.resolve(PluginFile(data: jpg, name: "image.jpg"))
        }
    }
}

// MARK: - AVCapturePhotoCaptureDelegate

/// One capture: the photo output holds its delegate weakly, so this keeps itself until the capture
/// is over (`didFinishCaptureFor` comes last, whatever happened) and completes exactly once.
private final class PhotoCapture: NSObject, AVCapturePhotoCaptureDelegate {
    private var completion: ((UIImage?) -> Void)?
    private var image: UIImage?
    private var keep: PhotoCapture?

    init(_ completion: @escaping (UIImage?) -> Void) {
        self.completion = completion
        super.init()
        keep = self
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        guard error == nil, let data = photo.fileDataRepresentation() else { return }
        image = UIImage(data: data)
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        completion?(image)
        completion = nil
        keep = nil
    }
}
