//
//  AppleSignInService.swift — lecodes-plugins/apple-sign-in
//
//  The "appleSignIn" service over ASAuthorizationController. The channel (the call, the options,
//  the credential, the codes) is AppleSignIn.gen.swift, generated from contract.d.ts.
//
//  One sheet at a time: a call while one is up rejects "busy". The person closing the sheet is
//  not a failure — the call resolves with null.
//

import Foundation
import UIKit
import AuthenticationServices
import LeCodes

public final class AppleSignInService: NSObject, AppleSignInPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {

    typealias SignIn = Reply<AppleCredential?, AppleSignInCode>

    private var pending: SignIn?
    /// Held while the sheet is up: the controller is not retained by the system.
    private var controller: ASAuthorizationController?

    public func signIn(_ options: AppleSignInOptions?, _ reply: Reply<AppleCredential?, AppleSignInCode>) {
        DispatchQueue.main.async {
            guard self.pending == nil else { return reply.reject(.busy) }

            let request = ASAuthorizationAppleIDProvider().createRequest()
            let scopes = options?.scopes ?? [.fullName, .email]
            request.requestedScopes = scopes.map { $0 == .fullName ? .fullName : .email }
            if let nonce = options?.nonce, !nonce.isEmpty { request.nonce = nonce }

            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.pending = reply
            self.controller = controller
            controller.performRequests()
        }
    }

    public func close() {
        DispatchQueue.main.async { self.settle { $0.resolve(nil) } }
    }

    private func settle(_ with: (SignIn) -> Void) {
        guard let reply = pending else { return }
        pending = nil
        controller = nil
        with(reply)
    }

    // MARK: - ASAuthorizationControllerDelegate

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let token = credential.identityToken.flatMap({ String(data: $0, encoding: .utf8) }) else {
            return settle { $0.reject(.failed) }
        }
        let result = AppleCredential(
            user: credential.user,
            identityToken: token,
            authorizationCode: credential.authorizationCode.flatMap { String(data: $0, encoding: .utf8) },
            email: credential.email,
            givenName: credential.fullName?.givenName,
            familyName: credential.fullName?.familyName
        )
        settle { $0.resolve(result) }
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        // The person closed the sheet: not an error of the app's.
        if (error as? ASAuthorizationError)?.code == .canceled { return settle { $0.resolve(nil) } }
        NSLog("[apple-sign-in] failed: %@", String(describing: error))
        settle { $0.reject(.failed) }
    }

    // MARK: - ASAuthorizationControllerPresentationContextProviding

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scene = UIApplication.shared.connectedScenes.first(where: { $0 is UIWindowScene }) as? UIWindowScene
        return scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first ?? ASPresentationAnchor()
    }
}
