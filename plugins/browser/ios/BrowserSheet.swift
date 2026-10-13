//
//  BrowserSheet.swift — lecodes-plugins/browser
//
//  The "browser" service: the system's in-app browser. A plain `show` is an SFSafariViewController
//  presented over the app; one with a callbackScheme is an ASWebAuthenticationSession, which
//  intercepts the redirect itself and hands the URL back (no scheme registration, the cookie jar
//  of Safari, `ephemeral` honored). Either way the call resolves when the sheet goes — with the
//  callback URL when there was one — and `closed` fires.
//
//  One sheet at a time: a second `show` while one is up rejects with `busy`.
//

import UIKit
import SafariServices
import AuthenticationServices
import LeCodes

final class BrowserSheet: NSObject, BrowserPlugin, SFSafariViewControllerDelegate, ASWebAuthenticationPresentationContextProviding {

    private let events: BrowserEvents
    private var pending: Reply<BrowserResult, BrowserCode>?
    private var safari: SFSafariViewController?
    private var session: ASWebAuthenticationSession?

    init(_ events: BrowserEvents) {
        self.events = events
        super.init()
    }

    // MARK: - BrowserPlugin

    func show(_ url: String, _ options: BrowserOpenOptions?, _ reply: Reply<BrowserResult, BrowserCode>) {
        guard pending == nil else { return reply.reject(.busy) }
        guard let target = URL(string: url), let scheme = target.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return reply.reject(.invalid)
        }
        if let callback = options?.callbackScheme, !callback.isEmpty {
            let session = ASWebAuthenticationSession(url: target, callbackURLScheme: callback) { [weak self] url, _ in
                // Cancelled (the user, or `dismiss`) arrives as an error: the sheet went, no URL.
                DispatchQueue.main.async { self?.finish(url?.absoluteString) }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = options?.ephemeral ?? false
            pending = reply
            self.session = session
            if !session.start() {
                pending = nil
                self.session = nil
                reply.reject(.invalid)
            }
            return
        }
        guard let top = browserTopViewController() else { return reply.reject(.invalid) }
        let safari = SFSafariViewController(url: target)
        safari.delegate = self
        safari.dismissButtonStyle = .close
        if let color = browserColor(options?.color) {
            safari.preferredBarTintColor = color
            safari.preferredControlTintColor = color.isLight ? .black : .white
        }
        pending = reply
        self.safari = safari
        top.present(safari, animated: true)
    }

    func dismiss(_ reply: Reply<Void, BrowserCode>) {
        close()
        reply.resolve()
    }

    /// The app's dismiss, and the world's teardown: take the sheet down, settle what waits.
    func close() {
        if let session {
            self.session = nil
            session.cancel()   // its completion handler settles the reply
            if pending != nil { finish(nil) }
            return
        }
        if let safari {
            self.safari = nil
            // A programmatic dismiss does not call safariViewControllerDidFinish.
            safari.dismiss(animated: true)
            finish(nil)
        }
    }

    private func finish(_ url: String?) {
        session = nil
        safari = nil
        guard let reply = pending else { return }
        pending = nil
        reply.resolve(BrowserResult(url: url))
        events.closed()
    }

    // MARK: - SFSafariViewControllerDelegate

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        finish(nil)
    }

    // MARK: - ASWebAuthenticationPresentationContextProviding

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scene = UIApplication.shared.connectedScenes.first(where: { $0 is UIWindowScene }) as? UIWindowScene
        return scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first ?? ASPresentationAnchor()
    }
}

private extension UIColor {
    var isLight: Bool {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        return 0.299 * r + 0.587 * g + 0.114 * b > 0.6
    }
}
