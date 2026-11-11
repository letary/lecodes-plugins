// apple-sign-in — Sign in with Apple, through the system's own sheet.
// There is no URL in this flow and no browser: iOS shows its sheet over the app, the person
// confirms with Face ID, and the app gets an IDENTITY TOKEN — a JWT signed by Apple whose audience
// is the app's bundle id. The app's server verifies it (Apple's public keys) and reads the person's
// id (`sub`) and e-mail from it; nothing here is trusted without that check.
//
// iOS only. Apple's flow for other platforms is a web page with a Services ID — another client,
// another audience of the token — and is opened like any OAuth page (`Browser.open`).
//
// The name and the e-mail come ONCE, at the person's first sign-in to this app: Apple never sends
// them again (until the person removes the app from their Apple ID). Send them to the server with
// that first token.

import type { Service } from "lecodes-sdk/plugin"

export type AppleSignInScope = "fullName" | "email"

export interface AppleSignInOptions {
  /** What to ask of the person besides their id. Default: both. */
  scopes?: AppleSignInScope[]
  /** A value the token carries back in its `nonce` claim, as it is given here — the server that
   *  made it checks it, against a replayed token. Give the SHA-256 of the server's nonce when the
   *  server expects the hash (Firebase does). */
  nonce?: string
}

export interface AppleCredential {
  /** The person's id at Apple, stable for this app's team — the token's `sub`. */
  user: string
  /** The JWT to send to the server. */
  identityToken: string
  /** A one-time code the server may exchange at Apple for a refresh token; null when Apple gave none. */
  authorizationCode: string | null
  /** First sign-in only. */
  email: string | null
  /** First sign-in only. */
  givenName: string | null
  /** First sign-in only. */
  familyName: string | null
}

export interface AppleSignInParams {}

export interface AppleSignInEvents {}

export interface AppleSignIn extends Service<"appleSignIn", AppleSignInParams, AppleSignInEvents> {
  /** Show the system's sheet. Resolves with the credential, or with null when the person closed
   *  the sheet. One sheet at a time.
   *  @rejects busy failed */
  signIn(options?: AppleSignInOptions): Promise<AppleCredential | null>
}
