//
//  QRScannerPlugin.swift — lecodes-plugins/qr-scanner
//
//  The "qrScanner" view: a camera preview that decodes QR codes and reports them as `scan` events
//  (data: nil when the code leaves the frame). The channel is QRScanner.gen.swift, generated from
//  contract.d.ts.
//

import UIKit
import LeCodes

public enum LeCodesQRScannerPlugin {

    public static let pluginId = "qr-scanner"

    public static func register(in engine: LeCodesEngine) {
        QRScannerChannel.register(in: engine) { _, events in Scanner(events) }
    }
}

/// One scanner view of the app.
final class Scanner: QRScannerPlugin {

    private let scannerView: QRScannerView

    var view: UIView { scannerView }

    init(_ events: QRScannerEvents) {
        scannerView = QRScannerView(onData: { data in events.scan(data: data) })
    }

    /// The world swap drops this instance on the MAIN thread — hand the capture session to its
    /// serial queue first, so the session never deallocates on main mid-stop (that block froze the
    /// UI for seconds right as the scanned project booted, queueing every touch until the camera
    /// stack settled).
    func destroy() {
        scannerView.shutdown()
    }
}
