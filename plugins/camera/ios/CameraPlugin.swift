//
//  CameraPlugin.swift — lecodes-plugins/camera
//
//  The "camera" view: a live preview with still capture. WHEN and WITH WHAT to open it is the
//  app's code; the channel itself (the calls, their arguments, the File a photo crosses as) is
//  CameraView.gen.swift, generated from contract.d.ts.
//

import UIKit
import LeCodes

public enum LeCodesCameraPlugin {

    public static let pluginId = "camera"

    public static func register(in engine: LeCodesEngine) {
        CameraViewChannel.register(in: engine) { params, _ in Camera(params) }
    }
}

/// One camera view of the app.
final class Camera: CameraViewPlugin {

    private let cameraView: CameraView

    var view: UIView { cameraView }

    init(_ params: CameraParams) {
        cameraView = CameraView(facingMode: params.facingMode == .front ? .front : .back)
    }

    func takePhoto(_ reply: Reply<PluginFile, CameraViewCode>) {
        cameraView.takePhoto { image in
            guard let image, let jpg = image.jpegData(compressionQuality: 0.95) else { return reply.reject(.failed) }
            reply.resolve(PluginFile(data: jpg, name: "image.jpg"))
        }
    }

    func setFacingMode(_ mode: Facing, _ reply: Reply<Void, CameraViewCode>) {
        cameraView.cameraSetFacingMode(mode == .front ? .front : .back)
        reply.resolve()
    }

    /// The world swap drops this instance on the MAIN thread — hand the capture session to its
    /// serial queue first, so the session never deallocates on main mid-stop (the freeze of the QR
    /// scanner: seconds of queued touches right as the next project boots).
    func destroy() {
        cameraView.shutdown()
    }
}
