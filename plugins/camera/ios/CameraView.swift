//
//  CameraView.swift
//
//  Threading: ALL AVCaptureSession work (configuration, startRunning, stopRunning,
//  facing-mode swaps, teardown) happens on one serial `sessionQueue` — the same
//  contract as QRScannerView. AVFoundation blocks the calling thread for hardware
//  arbitration, so session setup or dealloc on the main thread freezes the UI for
//  seconds (touches queue up and replay when the camera stack settles). The shutdown
//  block captures the session strongly, so a world swap dropping the last reference
//  on the main thread never deallocates a running session there. The serial queue
//  also keeps start/stop/reconfigure from racing each other.
//

import UIKit
import AVFoundation

enum CameraFacingMode {
    case front
    case back
}

class CameraView: UIView {

    // MARK: - Private

    private static let sessionQueue = DispatchQueue(label: "lecodes.camera.session", qos: .userInitiated)

    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var photoCompletion: ((UIImage?) -> Void)?
    private var facingMode: CameraFacingMode
    private var didShutdown = false

    // MARK: - Init

    init(facingMode: CameraFacingMode = .back) {
        self.facingMode = facingMode
        super.init(frame: .zero)
        setupCamera()
    }

    required init?(coder: NSCoder) {
        self.facingMode = .back
        super.init(coder: coder)
        setupCamera()
    }

    deinit {
        // Last-resort teardown for a release without window removal (world swap drops
        // the plugin instance directly). The block keeps the session AND preview layer
        // alive until the stop completes, so both dealloc on the session queue — never
        // on main (preview-layer dealloc syncs with the capture pipeline; a collision
        // with an in-flight stop was measured blocking main for 9s in the QR twin).
        Self.stop(session, releasing: previewLayer)
    }

    // MARK: - Setup

    private func setupCamera() {
        // The preview layer is cheap and main-thread-bound; attach it now so layout
        // works immediately. It shows frames once the session starts on the queue.
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        // Bottom of the stack: overlays mount as subviews (their layers are sublayers
        // here), and the preview must never cover them regardless of mount timing.
        layer.insertSublayer(preview, at: 0)
        previewLayer = preview

        let position: AVCaptureDevice.Position = facingMode == .front ? .front : .back
        Self.sessionQueue.async { [session, photoOutput] in
            // Device lookup + input creation negotiate with the camera hardware — the
            // parts that block for hundreds of ms and must stay off the main thread.
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input),
                  session.canAddOutput(photoOutput) else { return }

            session.addInput(input)
            session.addOutput(photoOutput)
        }
    }

    // MARK: - Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer?.frame = bounds
    }

    // MARK: - Lifecycle

    override func didMoveToWindow() {
        super.didMoveToWindow()

        if window != nil {
            guard !didShutdown else { return }
            Self.sessionQueue.async { [session] in
                if !session.isRunning { session.startRunning() }
            }
        } else {
            Self.stop(session)
        }
    }

    /// Explicit teardown (plugin destroy). Idempotent; safe from the main thread — the
    /// stop, the session's dealloc, AND the preview layer's dealloc all happen on the
    /// session queue (both objects hold connections into the capture pipeline).
    func shutdown() {
        didShutdown = true
        photoCompletion = nil
        let preview = previewLayer
        preview?.removeFromSuperlayer()      // pure layer-tree detach — cheap on main
        previewLayer = nil
        Self.stop(session, releasing: preview)
    }

    private static func stop(_ session: AVCaptureSession, releasing preview: AVCaptureVideoPreviewLayer? = nil) {
        sessionQueue.async {
            if session.isRunning { session.stopRunning() }
            preview?.session = nil
            // The block's strong captures release the session and the preview layer
            // here, on the session queue.
        }
    }

    // MARK: - Public

    func cameraSetFacingMode(_ facingMode: CameraFacingMode) {
        guard self.facingMode != facingMode else { return }
        self.facingMode = facingMode

        let position: AVCaptureDevice.Position = facingMode == .front ? .front : .back
        Self.sessionQueue.async { [session] in
            session.beginConfiguration()

            session.inputs.forEach { session.removeInput($0) }

            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else {
                session.commitConfiguration()
                return
            }

            session.addInput(input)
            session.commitConfiguration()
        }
    }

    func takePhoto(completion: @escaping (UIImage?) -> Void) {
        photoCompletion = completion
        let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
        photoOutput.capturePhoto(with: settings, delegate: self)
    }
}

// MARK: - AVCapturePhotoCaptureDelegate

extension CameraView: AVCapturePhotoCaptureDelegate {

    func photoOutput(_ output: AVCapturePhotoOutput,
                     didFinishProcessingPhoto photo: AVCapturePhoto,
                     error: Error?) {
        guard error == nil,
              let data = photo.fileDataRepresentation(),
              let image = UIImage(data: data) else {
            photoCompletion?(nil)
            return
        }
        photoCompletion?(image)
        photoCompletion = nil
    }
}
