//
//  CameraView.swift
//

import UIKit
import AVFoundation

enum CameraFacingMode {
    case front
    case back
}

class CameraView: UIView {

    // MARK: - Private

    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var photoCompletion: ((UIImage?) -> Void)?
    private var facingMode: CameraFacingMode

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

    // MARK: - Setup

    private func setupCamera() {
        let position: AVCaptureDevice.Position = facingMode == .front ? .front : .back
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input),
              session.canAddOutput(photoOutput) else { return }

        session.addInput(input)
        session.addOutput(photoOutput)

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        layer.addSublayer(preview)
        previewLayer = preview
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
            DispatchQueue.global(qos: .userInitiated).async {
                if !self.session.isRunning { self.session.startRunning() }
            }
        } else {
            DispatchQueue.global(qos: .userInitiated).async {
                if self.session.isRunning { self.session.stopRunning() }
            }
        }
    }

    // MARK: - Public

    func cameraSetFacingMode(_ facingMode: CameraFacingMode) {
        guard self.facingMode != facingMode else { return }
        self.facingMode = facingMode

        DispatchQueue.global(qos: .userInitiated).async {
            self.session.beginConfiguration()

            self.session.inputs.forEach { self.session.removeInput($0) }

            let position: AVCaptureDevice.Position = facingMode == .front ? .front : .back
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
                  let input = try? AVCaptureDeviceInput(device: device),
                  self.session.canAddInput(input) else {
                self.session.commitConfiguration()
                return
            }

            self.session.addInput(input)
            self.session.commitConfiguration()
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
