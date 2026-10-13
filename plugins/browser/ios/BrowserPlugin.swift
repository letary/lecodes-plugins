//
//  BrowserPlugin.swift — lecodes-plugins/browser
//
//  The "browser" service (the system sheet: SFSafariViewController, ASWebAuthenticationSession for
//  a flow with a callback scheme) and the "webView" view (WKWebView). WHEN and WITH WHAT to open
//  them is the app's code; the channels themselves (the calls, the params, the events) are
//  BrowserPlugin.gen.swift, generated from contract.d.ts.
//

import UIKit
import LeCodes

public enum LeCodesBrowserPlugin {

    public static let pluginId = "browser"

    public static func register(in engine: LeCodesEngine) {
        BrowserChannel.register(in: engine) { _, events in BrowserSheet(events) }
        WebViewChannel.register(in: engine) { params, events in WebViewPage(params, events) }
    }
}

/// "#RGB" / "#RRGGBB" / "#RRGGBBAA" → a color; anything else nil.
func browserColor(_ hex: String?) -> UIColor? {
    guard var s = hex?.trimmingCharacters(in: .whitespaces), s.hasPrefix("#") else { return nil }
    s.removeFirst()
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    guard s.count == 6 || s.count == 8, let v = UInt32(s, radix: 16) else { return nil }
    let (r, g, b, a): (UInt32, UInt32, UInt32, UInt32) = s.count == 8
        ? (v >> 24 & 0xff, v >> 16 & 0xff, v >> 8 & 0xff, v & 0xff)
        : (v >> 16 & 0xff, v >> 8 & 0xff, v & 0xff, 0xff)
    return UIColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: CGFloat(a) / 255)
}

/// The controller to present over: the key window's top-most presented one.
func browserTopViewController() -> UIViewController? {
    guard let scene = UIApplication.shared.connectedScenes.first(where: { $0 is UIWindowScene }) as? UIWindowScene,
          let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return nil }
    var top = window.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
}
