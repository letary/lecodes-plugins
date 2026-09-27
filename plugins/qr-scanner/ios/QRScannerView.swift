//
//  QRScannerView.swift
//  App
//
//  Created by Denis Hohryakov on 2026.01.20.
//
//  Threading: ALL AVCaptureSession work (configuration, startRunning, stopRunning,
//  and the final teardown) happens on one serial `sessionQueue`. AVFoundation blocks
//  the calling thread for hardware arbitration — session setup or dealloc on the main
//  thread froze the UI for seconds right as a scanned project was booting (den's
//  "non-interactive until the font loads" report: touches queued during the freeze
//  replayed when the camera stack finally settled). The teardown block captures the
//  session strongly, so even when the world swap drops the last view reference on
//  main, the session's dealloc happens HERE, never on the main thread. A serial queue
//  (not .global()) also keeps startRunning/stopRunning from racing each other on a
//  fast scan→close.
//

import UIKit
import AVFoundation

class QRScannerView: UIView, AVCaptureMetadataOutputObjectsDelegate {

    private static let sessionQueue = DispatchQueue(label: "lecodes.qr-scanner.session", qos: .userInitiated)

    private var captureSession: AVCaptureSession?      // set on sessionQueue, cleared in shutdown()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var onData: ((String?) -> Void)?
    private var hideWorkItem: DispatchWorkItem?
    private var lastValue: String?
    private var didShutdown = false

    init(onData: @escaping (String?) -> Void) {
        self.onData = onData
        super.init(frame: .zero)
        setupCamera()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
    }

    deinit {
        // Last-resort teardown for a view released without window removal (world swap
        // drops the plugin instance directly). The preview layer rides along: its
        // dealloc syncs with the capture pipeline, so it must not die on main either
        // (measured 9s main-thread wait when it collided with an in-flight stop).
        Self.stop(captureSession, releasing: previewLayer)
    }

    private func setupCamera() {
        Self.sessionQueue.async {
            // Device lookup + input creation negotiate with the camera hardware — the
            // parts that block for hundreds of ms and must stay off the main thread.
            guard let videoCaptureDevice = AVCaptureDevice.default(for: .video),
                  let videoInput = try? AVCaptureDeviceInput(device: videoCaptureDevice) else { return }

            let session = AVCaptureSession()
            if session.canAddInput(videoInput) {
                session.addInput(videoInput)
            }

            let metadataOutput = AVCaptureMetadataOutput()
            if session.canAddOutput(metadataOutput) {
                session.addOutput(metadataOutput)
                metadataOutput.metadataObjectTypes = [.qr]
            }

            // Delegate + preview are main-actor; arm them BEFORE the session starts so
            // no frame is missed, then start back on the session queue.
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.didShutdown else {
                    Self.stop(session)               // died/closed before the camera came up
                    return
                }
                self.captureSession = session
                metadataOutput.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)

                let previewLayer = AVCaptureVideoPreviewLayer(session: session)
                previewLayer.videoGravity = .resizeAspectFill
                previewLayer.frame = self.bounds
                // The preview now arrives AFTER whatever was mounted while the session
                // configured (widget overlays attach as subviews, and a subview's layer
                // is a sublayer here) — insert at the bottom so it never covers them.
                self.layer.insertSublayer(previewLayer, at: 0)
                self.previewLayer = previewLayer
                self.updateVideoOrientation()
                self.observeSession(session)

                Self.sessionQueue.async {
                    if !session.isRunning { session.startRunning() }
                }
            }
        }
    }

    /// The capture pipeline's own reports (an interruption by another client / the background, a
    /// runtime error): logged — a black preview with the session "running" is one of these.
    private func observeSession(_ session: AVCaptureSession) {
        let nc = NotificationCenter.default
        nc.addObserver(forName: .AVCaptureSessionWasInterrupted, object: session, queue: .main) { n in
            print("[qr] session interrupted: \(n.userInfo?[AVCaptureSessionInterruptionReasonKey] ?? "?")")
        }
        nc.addObserver(forName: .AVCaptureSessionInterruptionEnded, object: session, queue: .main) { _ in
            print("[qr] session interruption ended")
        }
        nc.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: .main) { n in
            print("[qr] session runtime error: \(n.userInfo?[AVCaptureSessionErrorKey] ?? "?")")
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer?.frame = bounds
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {

        hideWorkItem?.cancel()

        if let metadataObject = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
           let stringValue = metadataObject.stringValue,
           lastValue != stringValue {
            lastValue = stringValue
            self.onData?(stringValue)
        }

        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            if self.lastValue != nil {
                self.lastValue = nil
                self.onData?(nil)
            }
        }
        hideWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: workItem)
    }

    private func updateVideoOrientation() {
        guard let connection = previewLayer?.connection,
              connection.isVideoOrientationSupported else { return }

        let orientation = UIApplication.shared.windows.first?.windowScene?.interfaceOrientation

        switch orientation {
        case .portrait:
            connection.videoOrientation = .portrait
        case .portraitUpsideDown:
            connection.videoOrientation = .portraitUpsideDown
        case .landscapeLeft:
            connection.videoOrientation = .landscapeLeft
        case .landscapeRight:
            connection.videoOrientation = .landscapeRight
        default:
            connection.videoOrientation = .portrait
        }
    }

    /// Re-arm scanning after a previous stop (the scanner UI reuses one instance).
    func startScanning() {
        guard !didShutdown, let session = captureSession else { return }
        Self.sessionQueue.async {
            if !session.isRunning { session.startRunning() }
        }
    }

    func onScreenRotate() {
        updateVideoOrientation()
    }

    /// Explicit teardown (plugin destroy / window removal). Idempotent. The session AND
    /// the preview layer move into the queue block: both hold connections into the
    /// capture pipeline, so releasing either on main while a stop is in flight makes
    /// the main thread join the capture queue (measured: a 9s freeze in the world swap).
    func shutdown() {
        didShutdown = true
        hideWorkItem?.cancel()
        onData = nil
        let preview = previewLayer
        preview?.removeFromSuperlayer()      // pure layer-tree detach — cheap on main
        previewLayer = nil
        Self.stop(captureSession, releasing: preview)
        captureSession = nil
    }

    private static func stop(_ session: AVCaptureSession?, releasing preview: AVCaptureVideoPreviewLayer? = nil) {
        guard session != nil || preview != nil else { return }
        sessionQueue.async {
            if let session, session.isRunning { session.stopRunning() }
            preview?.session = nil
            // The block's strong captures release the session and the preview layer
            // here, on the session queue — never on main.
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            hideWorkItem?.cancel()
            Self.stop(captureSession)
        } else if !didShutdown {
            startScanning()
        }
    }
}
