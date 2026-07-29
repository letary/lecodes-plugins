//
//  QRScannerView.swift
//  App
//
//  Created by Denis Hohryakov on 2026.01.20.
//

import UIKit
import AVFoundation

class QRScannerView: UIView, AVCaptureMetadataOutputObjectsDelegate {
    
    private var captureSession: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var onData: ((String?) -> Void)?
    private var hideWorkItem: DispatchWorkItem?
    private var lastValue: String?
    
    init(onData: @escaping (String?) -> Void) {
        self.onData = onData
        super.init(frame: .zero)
        setupCamera()
    }
    
    required init?(coder: NSCoder) {
        super.init(coder: coder)
    }
    
    private func setupCamera() {
        guard let videoCaptureDevice = AVCaptureDevice.default(for: .video) else { return }
        
        let session = AVCaptureSession()
        guard let videoInput = try? AVCaptureDeviceInput(device: videoCaptureDevice) else { return }
        if session.canAddInput(videoInput) {
            session.addInput(videoInput)
        }
        
        let metadataOutput = AVCaptureMetadataOutput()
        if session.canAddOutput(metadataOutput) {
            session.addOutput(metadataOutput)
            metadataOutput.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
            metadataOutput.metadataObjectTypes = [.qr]
        }
        
        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        layer.addSublayer(previewLayer)
        self.previewLayer = previewLayer
        updateVideoOrientation()
        
        self.captureSession = session
        
        startScanning()
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
           let stringValue = metadataObject.stringValue {
            
            if lastValue != stringValue {
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
            
        } else {
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

    
    /// Запуск сканирования
    func startScanning() {
        guard let session = captureSession, !session.isRunning else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
        }
    }
    
    func onScreenRotate() {
        updateVideoOrientation()
    }
    
    override func didMoveToWindow() {
        super.didMoveToWindow()

        if window == nil {
            hideWorkItem?.cancel()
            guard let session = captureSession, session.isRunning else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                session.stopRunning()
            }
        }
    }
}
