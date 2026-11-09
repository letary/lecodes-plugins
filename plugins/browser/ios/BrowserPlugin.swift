//
//  BrowserPlugin.swift — lecodes-plugins/browser
//
//  The "browser" service (the system sheet: SFSafariViewController, ASWebAuthenticationSession for
//  a flow with a callback scheme) and the embedded web view on its two surfaces, one page class
//  under both (WebViewPage.swift):
//   - the VIEW "webView" (WebViewInstance): the fullscreen page the app pushes or opens; its params
//     are read once, at creation, and its view is the WKWebView itself;
//   - the HOST NODE "webView" (WebViewNodeInstance): the page as a box of a screen's layout, laid
//     out and painted by the core's holder (UINodeHost); `url`, `stops` and `externalLinks` are LIVE.
//  WHEN and WITH WHAT to open them is the app's code; the channels themselves (the calls, the params,
//  the props, the events) are BrowserPlugin.gen.swift, generated from contract.d.ts.
//
//  The node's rules:
//   - Its props arrive one by one (the holder hands each write over, `kind` first), and three of them
//     are WKWebView's configuration (`bridge`, `userAgent`, `ephemeral`), which exists only before the
//     web view does. So the page is made at the END of the node's first commit — a main-queue turn
//     after the instance (the commit hands its props over right after the `kind` write that made it)
//     — from every prop that commit wrote, its `url` the first page. The instance's view is a plain
//     box (WebViewNodeBox) that takes the web view in then.
//   - Later commits are applied the same way, once per commit: `stops` and `externalLinks` take
//     effect for the next navigation, a `url` write loads it (a cleared one loads nothing). A later
//     write of a configuration prop that changes it is ignored, with one log line per prop.
//   - A call flushes what is pending first: it sees every prop written before it (and makes the page
//     when it comes before the first turn — `nodeCall` keeps its place in the commit).
//   - `destroy` (the node released) tears the page down; a flush after it does nothing.
//

import UIKit
import LeCodes

public enum LeCodesBrowserPlugin {

    public static let pluginId = "browser"

    public static func register(in engine: LeCodesEngine) {
        BrowserChannel.register(in: engine) { _, events in BrowserSheet(events) }
        WebViewChannel.register(in: engine) { params, events in WebViewInstance(params, events) }
        UIWebViewNodeGlue.register(in: engine) { events in WebViewNodeInstance(events) }
    }
}

// MARK: - The View

/// The view "webView": a WebViewPage made from the View's params, its web view the View's.
final class WebViewInstance: WebViewPlugin {
    private let page: WebViewPage

    var view: UIView { page.webView }

    init(_ params: WebViewParams, _ events: WebViewEvents) {
        page = WebViewPage(params, events)
    }

    func destroy() { page.destroy() }

    func load(_ url: String, _ headers: [String: String]?, _ reply: Reply<Void, WebViewCode>) { page.load(url, headers, reply) }
    func loadHtml(_ html: String, _ baseUrl: String?, _ reply: Reply<Void, WebViewCode>) { page.loadHtml(html, baseUrl, reply) }
    func setStops(_ stops: [String], _ reply: Reply<Void, WebViewCode>) { page.setStops(stops, reply) }
    func reload(_ reply: Reply<Void, WebViewCode>) { page.reload(reply) }
    func stopLoading(_ reply: Reply<Void, WebViewCode>) { page.stopLoading(reply) }
    func goBack(_ reply: Reply<Void, WebViewCode>) { page.goBack(reply) }
    func goForward(_ reply: Reply<Void, WebViewCode>) { page.goForward(reply) }
    func canGoBack(_ reply: Reply<Bool, WebViewCode>) { page.canGoBack(reply) }
    func evaluate(_ js: String, _ reply: Reply<Any, WebViewCode>) { page.evaluate(js, reply) }
    func postMessage(_ data: Any, _ reply: Reply<Void, WebViewCode>) { page.postMessage(data, reply) }
    func clearData(_ reply: Reply<Void, WebViewCode>) { page.clearData(reply) }
}

// MARK: - The host node

/// The host node "webView": a box of the layout holding a WebViewPage (the header's rules).
final class WebViewNodeInstance: UIWebViewNodeInstance {
    /// The live props written since the last flush.
    private struct Dirty: OptionSet {
        let rawValue: Int
        static let url = Dirty(rawValue: 1 << 0)
        static let stops = Dirty(rawValue: 1 << 1)
        static let externalLinks = Dirty(rawValue: 1 << 2)
    }

    private let box = WebViewNodeBox()
    var view: UIView { box }
    private let events: UIWebViewNodeEvents
    /// Every prop as written last, in the View's params' fields: what the page is made from.
    private var props = WebViewParams()
    private var dirty: Dirty = []
    private var flushQueued = true
    private var page: WebViewPage?
    /// The configuration props a write after the page was made changed — logged once each.
    private var ignored: Set<String> = []
    private var destroyed = false

    init(_ events: UIWebViewNodeEvents) {
        self.events = events
        // The end of the first commit: its props are in by then.
        DispatchQueue.main.async { [weak self] in _ = self?.flush() }
    }

    func set(url: String?) { props.url = url; mark(.url) }
    func set(stops: [String]?) { props.stops = stops; mark(.stops) }
    func set(externalLinks: WebViewPropsExternalLinks?) {
        props.externalLinks = externalLinks.map { $0 == .block ? .block : .open }
        mark(.externalLinks)
    }
    func set(bridge: Bool?) {
        guard creating("bridge", changes: (bridge ?? false) != (props.bridge ?? false)) else { return }
        props.bridge = bridge
    }
    func set(userAgent: String?) {
        guard creating("userAgent", changes: userAgent != props.userAgent) else { return }
        props.userAgent = userAgent
    }
    func set(ephemeral: Bool?) {
        guard creating("ephemeral", changes: (ephemeral ?? false) != (props.ephemeral ?? false)) else { return }
        props.ephemeral = ephemeral
    }

    /// A configuration prop: taken while the page is not made yet; after, a write that changes it is
    /// ignored, with one log line per prop.
    private func creating(_ prop: String, changes: Bool) -> Bool {
        if page == nil && !destroyed { return true }
        if changes && ignored.insert(prop).inserted {
            print("LeCodes: UIWebViewNode: `\(prop)` is read when the page is made, at the node's first commit — the later write is ignored")
        }
        return false
    }

    func destroy() {
        destroyed = true
        page?.destroy()
        page = nil
    }

    /// A live prop changed: applied with the rest of its commit, a main-queue turn later.
    private func mark(_ prop: Dirty) {
        dirty.insert(prop)
        guard !flushQueued else { return }
        flushQueued = true
        DispatchQueue.main.async { [weak self] in _ = self?.flush() }
    }

    /// Apply what was written since the last flush — the first one makes the page from every prop.
    /// The page; nil once destroyed.
    private func flush() -> WebViewPage? {
        flushQueued = false
        guard !destroyed else { return nil }
        let changed = dirty
        dirty = []
        guard let page else {
            let made = WebViewPage(props, events)
            box.adopt(made.webView)
            page = made
            return made
        }
        if changed.contains(.stops) { page.stops = props.stops ?? [] }
        if changed.contains(.externalLinks) { page.openExternal = props.externalLinks != .block }
        if changed.contains(.url), let url = props.url { page.open(url) }
        return page
    }

    // The calls see every prop written before them.

    func load(_ url: String, _ headers: [String: String]?, _ reply: Reply<Void, UIWebViewNodeCode>) {
        guard let page = flush() else { return reply.fail(Self.gone) }
        page.load(url, headers, reply)
    }
    func loadHtml(_ html: String, _ baseUrl: String?, _ reply: Reply<Void, UIWebViewNodeCode>) {
        guard let page = flush() else { return reply.fail(Self.gone) }
        page.loadHtml(html, baseUrl, reply)
    }
    func setStops(_ stops: [String], _ reply: Reply<Void, UIWebViewNodeCode>) {
        guard let page = flush() else { return reply.fail(Self.gone) }
        props.stops = stops
        page.setStops(stops, reply)
    }
    func reload(_ reply: Reply<Void, UIWebViewNodeCode>) {
        guard let page = flush() else { return reply.fail(Self.gone) }
        page.reload(reply)
    }
    func stopLoading(_ reply: Reply<Void, UIWebViewNodeCode>) {
        guard let page = flush() else { return reply.fail(Self.gone) }
        page.stopLoading(reply)
    }
    func goBack(_ reply: Reply<Void, UIWebViewNodeCode>) {
        guard let page = flush() else { return reply.fail(Self.gone) }
        page.goBack(reply)
    }
    func goForward(_ reply: Reply<Void, UIWebViewNodeCode>) {
        guard let page = flush() else { return reply.fail(Self.gone) }
        page.goForward(reply)
    }
    func canGoBack(_ reply: Reply<Bool, UIWebViewNodeCode>) {
        guard let page = flush() else { return reply.fail(Self.gone) }
        page.canGoBack(reply)
    }
    func evaluate(_ js: String, _ reply: Reply<Any, UIWebViewNodeCode>) {
        guard let page = flush() else { return reply.fail(Self.gone) }
        page.evaluate(js, reply)
    }
    func postMessage(_ data: Any, _ reply: Reply<Void, UIWebViewNodeCode>) {
        guard let page = flush() else { return reply.fail(Self.gone) }
        page.postMessage(data, reply)
    }
    func clearData(_ reply: Reply<Void, UIWebViewNodeCode>) {
        guard let page = flush() else { return reply.fail(Self.gone) }
        page.clearData(reply)
    }

    private static let gone = "the host node is gone"
}

/// The node's view: the web view inside at the box's bounds, from the first flush on. The holder
/// lays this box out as the node's and paints the box paint (radius, border, shadow) over it.
final class WebViewNodeBox: UIView {
    func adopt(_ page: UIView) {
        page.frame = bounds
        page.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(page)
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
