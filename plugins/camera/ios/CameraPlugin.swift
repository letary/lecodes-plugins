//
//  CameraPlugin.swift — lecodes-plugins/camera
//
//  The plugin's two surfaces, one camera preview class under both (CameraPreview.swift):
//   - the VIEW "camera" (CameraViewInstance): the fullscreen preview the app pushes or opens; its
//     params are read once, at creation, and its view is the preview itself;
//   - the HOST NODE "camera" (CameraNodeInstance): the preview as a box of a screen's layout, laid
//     out and painted by the core's holder (UINodeHost); its prop `facingMode` is LIVE.
//  WHEN and WITH WHAT to show either is the app's code; the calls, their arguments, the File a photo
//  crosses as and the events are CameraViewPlugin.gen.swift, generated from contract.d.ts (one file
//  for both surfaces: the contract's types once, the View's channel, the node's glue).
//
//  The camera permission:
//   - the View's is asked by the SDK's wrapper BEFORE the View is presented (`prepareCamera`: the
//     current destination stays on screen while the dialog is up), so the View starts at once;
//   - the node's is asked HERE, through the engine's permissions (the SDK's same service): a node is
//     no destination, nothing presents it. The session starts a main-queue turn after the instance
//     is made — the node's first commit hands its props over right after the `kind` write that made
//     it, so the camera attached is the one `facingMode` says — once the permission is granted;
//     denied, the node sends `error` and stays an empty preview.
//

import UIKit
import LeCodes

public enum LeCodesCameraPlugin {

    public static let pluginId = "camera"

    public static func register(in engine: LeCodesEngine) {
        CameraViewChannel.register(in: engine) { params, events in CameraViewInstance(params, events) }
        UICameraNodeGlue.register(in: engine) { [permissions = engine.permissions] events in
            CameraNodeInstance(permissions, events)
        }
    }
}

// MARK: - The View

/// The view "camera": a CameraPreview started at once, on the camera of the View's params.
final class CameraViewInstance: CameraViewPlugin {

    private let preview: CameraPreview

    var view: UIView { preview }

    init(_ params: CameraParams, _ events: CameraViewEvents) {
        preview = CameraPreview(facingMode: params.facingMode.mode)
        preview.onError = { message in events.error(message: message) }
        preview.start()
    }

    func takePhoto(_ reply: Reply<PluginFile, CameraViewCode>) { preview.takePhoto(reply) }

    func setFacingMode(_ mode: Facing, _ reply: Reply<Void, CameraViewCode>) {
        preview.setFacingMode(Optional(mode).mode)
        reply.resolve()
    }

    /// The world swap drops this instance on the MAIN thread — hand the capture session to its
    /// serial queue first, so the session never deallocates on main mid-stop (the freeze of the QR
    /// scanner: seconds of queued touches right as the next project boots).
    func destroy() { preview.shutdown() }
}

// MARK: - The host node

/// The host node "camera": a CameraPreview as the node's box, started after the first commit and
/// the permission (the header's rules).
final class CameraNodeInstance: UICameraNodeInstance {

    private let preview = CameraPreview()
    private let events: UICameraNodeEvents
    private var destroyed = false

    var view: UIView { preview }

    init(_ permissions: Permissions, _ events: UICameraNodeEvents) {
        self.events = events
        preview.onError = { message in events.error(message: message) }
        DispatchQueue.main.async { [weak self] in self?.askThenStart(permissions) }
    }

    private func askThenStart(_ permissions: Permissions) {
        guard !destroyed else { return }
        permissions.request(.camera) { [weak self] state in
            guard let self, !self.destroyed else { return }
            guard state == .granted else { return self.events.error(message: "The camera permission was denied") }
            self.preview.start()
        }
    }

    /// A write switches the camera (before the start: picks the one it attaches).
    func set(facingMode: Facing?) { preview.setFacingMode(facingMode.mode) }

    func takePhoto(_ reply: Reply<PluginFile, UICameraNodeCode>) { preview.takePhoto(reply) }

    func setFacingMode(_ mode: Facing, _ reply: Reply<Void, UICameraNodeCode>) {
        preview.setFacingMode(Optional(mode).mode)
        reply.resolve()
    }

    /// The node released: the session stops and goes, on its queue (CameraViewInstance.destroy).
    func destroy() {
        destroyed = true
        preview.shutdown()
    }
}
