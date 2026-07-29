//
//  QRScannerPlugin.swift — lecodes-plugins/qr-scanner
//
//  The "qrScanner" registerView plugin: pairs with the SDK's QRScanner() wrapper, which
//  rides the generic NativeView channel — no per-plugin bridge methods.
//

import UIKit
import LeCodesSDK

public enum LeCodesQRScannerPlugin {

    public static let pluginId = "qr-scanner"

    public static func register(in engine: LeCodesEngine) {
        engine.registerView("qrScanner") { _, channel in
            QRScannerViewInstance(channel)
        }
    }
}

/// The "qrScanner" registerView factory product: wraps QRScannerView, forwarding decoded
/// codes as `scan { data }` events (data: null when the code leaves the frame).
final class QRScannerViewInstance: NativeViewInstance {

    let view: UIView

    init(_ channel: NativeViewChannel) {
        view = QRScannerView(onData: { data in
            channel.emit("scan", ["data": (data as Any?) ?? NSNull()])
        })
    }
}
