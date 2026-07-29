//
//  CameraPlugin.swift — lecodes-plugins/camera
//
//  The "camera" registerView plugin: WHEN and WITH WHAT to open it is app (TS) code —
//  the SDK's CameraView() wrapper rides the generic NativeView channel, no per-plugin
//  bridge methods.
//

import UIKit
import LeCodesSDK

public enum LeCodesCameraPlugin {

    public static let pluginId = "camera"

    public static func register(in engine: LeCodesEngine) {
        engine.registerView("camera") { [weak engine] params, _ in
            CameraViewInstance(params, engine)
        }
    }
}

/// The "camera" registerView factory product: wraps CameraView with the channel methods
/// the SDK's CameraView plugin calls — `takePhoto` → { systemId, name, size } and
/// `setFacingMode("front"|"back")`.
final class CameraViewInstance: NativeViewInstance {

    private let cameraView: CameraView
    private weak var engine: LeCodesEngine?

    var view: UIView { cameraView }

    init(_ params: Any?, _ engine: LeCodesEngine?) {
        let facing = (params as? [String: Any])?["facingMode"] as? String
        self.cameraView = CameraView(facingMode: facing == "front" ? .front : .back)
        self.engine = engine
    }

    func call(_ method: String, _ args: [Any], _ settle: ChannelSettle) {
        switch method {
        case "setFacingMode":
            cameraView.cameraSetFacingMode(args.first as? String == "front" ? .front : .back)
            settle.resolve()

        case "takePhoto":
            cameraView.takePhoto { [weak engine] image in
                guard let image, let jpg = image.jpegData(compressionQuality: 0.95) else {
                    settle.reject("Failed to take photo")
                    return
                }
                guard let engine else {
                    settle.reject("Engine is gone")
                    return
                }
                let systemId = engine.putBuffer(jpg)
                settle.resolve(["systemId": systemId, "name": "image.jpg", "size": jpg.count])
            }

        default:
            settle.reject("Unknown method: \(method)")
        }
    }
}
