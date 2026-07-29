# lecodes-plugins

First-party native plugins for LeCodes apps. One repo, one plugin per directory, with the
native code for **every platform** side by side:

```
plugins/
  camera/
    lecodes-plugin.json     # manifest — the only file tooling reads
    ios/                    # Swift sources (registerView/registerService adapters)
    android/                # Kotlin sources (same plugin, Android host)
  qr-scanner/
    lecodes-plugin.json
    ios/
    android/                # + libs/quirc-release.aar and consumer-rules.pro (see below)
  geolocation/              # "geolocation" service (extracted from the SDKs: on iOS linking
    lecodes-plugin.json     # CoreLocation makes Apple flag location usage; on Android the
    ios/                    # merged location permissions trigger Play data-safety — so only
    android/                # apps that install this plugin carry either)
  push/                     # "push" service: APNs/FCM machinery + le.codes relay registration
    lecodes-plugin.json
    ios/
    android/
```

## How plugins are consumed

Plugins are **source-vendored** by the `lecodes` CLI, not consumed as remote SPM/Gradle
dependencies. `lecodes app sync` copies `plugins/<id>/<platform>/` into the app's generated
shell (iOS: a target inside the app's local `LeCodesRuntime` Swift package; Android: a module in the
shell's Gradle project) and pins the repo tag in `plugins.lock.json`.

Why vendoring, deliberately:

- **SPM can't do this repo shape.** Remote SPM requires `Package.swift` at the repo root and
  can't parameterize dependencies — and `lecodes-ios-sdk` vends the same `LeCodesSDK` module
  from two products (`-core`/`-full`), so a plugin that hard-pinned one variant would collide
  with any app built on the other. Vendored targets inherit whichever variant the app chose.
- **Android needs no Maven.** The same repo carries Kotlin sources; the Android shell compiles
  them as a local Gradle module. Nothing to publish to Maven/JitPack.
- **One versioning story.** Repo-wide semver tags (`v1.0.0`); the lockfile records tag + commit.

The root `Package.swift` here is a **dev manifest only** — it exists so plugin authors can open
this repo in Xcode and build/test the iOS sources against the published SDK. Apps never
reference it. Build with an iOS destination (the SDK is an iOS-only binary):

```sh
xcodebuild -scheme lecodes-plugins-Package -destination 'generic/platform=iOS Simulator' build
```

## Manifest (`lecodes-plugin.json`)

```jsonc
{
  "id": "camera",                     // catalog id, kebab-case, globally unique
  "name": "Camera",
  "version": "1.0.0",
  "provides": { "views": ["camera"], "services": [] },  // channel names registered
  "js": null,                         // first-party JS wrappers live in the SDK;
                                      // third-party plugins point at a library slug here
  "ios": {
    "sources": "ios",                 // dir vendored into the app shell
    "module": "LeCodesCamera",        // Swift target name inside the shell's LeCodesRuntime package
    "register": "LeCodesCameraPlugin",// type exposing static register(in: LeCodesEngine)
    "minSdk": "1.0.2",                // minimum lecodes-ios-sdk version (sync hard-errors below it)
    "infoPlist": {                    // merged into the shell's Info.plist on sync
      "NSCameraUsageDescription": "…"
    },
    "entitlements": {                  // plist-typed JSON values (arrays allowed), e.g. the push
      "aps-environment": "development" // plugin's APNs capability — `lecodes app sync` merges
    }                                  // these into App/App.entitlements (scalar conflicts warn,
  },                                   // arrays flatten + dedupe).
  "android": {
    "sources": "android",              // dir vendored into the app shell; a Gradle-module-shaped
                                       // tree MINUS build.gradle (the CLI generates that):
                                       //   src/main/AndroidManifest.xml, src/main/java/…,
                                       //   src/main/res/…, libs/*.aar, consumer-rules.pro
    "module": "lecodes-camera",        // Gradle module name → :plugins:lecodes-camera
    "register": "io.letary.lecodes.plugins.camera.CameraPlugin",
                                       // Kotlin object exposing
                                       //   fun register(engine: LecodesEngine, context: Context)
                                       // (application context); its package is also the generated
                                       // module's AGP namespace
    "minSdk": "1.1.0",                 // minimum lecodes-android-sdk version — NOT Android's
                                       // minSdkVersion (the OS floor, API 23, comes from the SDK)
    "dependencies": [                  // optional Maven coords for the generated build.gradle;
      "platform:com.google.firebase:firebase-bom:34.16.0",  // "platform:" prefix → BoM
      "com.google.firebase:firebase-messaging"              // versionless only under a BoM
    ],
    "gradlePlugins": ["com.google.gms.google-services"]     // optional app-level Gradle plugins
  }                                    // null = platform not supported
}
```

Android conventions (no extra JSON keys): permissions, `<service>` declarations, and
`tools:node="remove"` entries ride the plugin's own `src/main/AndroidManifest.xml` — the AGP
manifest merger is the Android analog of the iOS Info.plist/entitlements merging. There is no
Android analog of `infoPlist` usage strings (Android permission dialogs are system-worded).
Every `libs/*.aar` under `sources` becomes a local file dependency; a `consumer-rules.pro`
becomes the module's consumer ProGuard rules.

Naming rule: first-party plugins own bare channel names (`camera`, `qrScanner`); third-party
view/service names must be vendor-prefixed (`acme.bluetooth`).

### Plugins that need app-delegate / activity moments (push)

On iOS a plugin cannot implement `UIApplicationDelegate` callbacks. The SDK (≥ 1.5.0) exposes
`LeCodesAppHooks` — a buffered forwarding surface the host app calls (`install()` in
`didFinishLaunching`, the APNs token callbacks, `connectionOptions.notificationResponse`
in scene connect); the generated shell templates include those lines, and the plugin
attaches its handler at `register(in:)` time. Buffering makes the ordering safe either way.

On Android there is no AppHooks analog — the plugin's manifest declares its own
`FirebaseMessagingService`, so token/message delivery needs no host code. What the host
activity does forward is tap routing: `PushPlugin.parkLaunchPayload(intent)` on a cold
create, `PushPlugin.handleTapIntent(intent)` in `onNewIntent` (before generic deep links),
and `PushPlugin.setForeground(...)` from `onResume`/`onPause`. The generated shell
templates include those lines.

**Push delivery scope:** an APNs auth key is team-scoped, so the le.codes relay signs sends
for EVERY Letary-published bundle id (`com.letary.*` — the viewer and shells Letary itself
ships): the plugin sends the shell's bundle id as `hostApp`, the relay picks the
`apns-topic` from it, and `lecodes app sync` merges the `aps-environment` entitlement and
bakes the project uuid as world identity (SDK ≥ 1.6.0). Bundle ids outside that namespace —
third-party Apple teams — reject at *registration* (`no_send_credentials` → the JS
`register()` rejects `"unavailable"`), honest and immediate, until the backend grows
per-project uploaded APNs keys.

The Android mirror: the relay sends FCM through Letary's Firebase project (`lecodes-15fad`),
so a shell needs a `google-services.json` from that project (Letary adds the package name on
request) at `android/app/google-services.json` — `lecodes app sync` applies the
google-services Gradle plugin only when the file exists and warns with instructions
otherwise. Tokens minted against other Firebase projects reject at registration the same
way, until per-project uploaded FCM service accounts land.

## JS side

The typed wrappers for these first-party plugins ship **in the SDK** (`CameraView`, `QRScanner`
globals) and tree-shake into any app bundle that references them, gated on
`isSupported` — installing a plugin here only adds the *native* half to the app shell.
