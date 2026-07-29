# lecodes-plugins

First-party native plugins for LeCodes apps. One repo, one plugin per directory, with the
native code for **every platform** side by side:

```
plugins/
  camera/
    lecodes-plugin.json     # manifest — the only file tooling reads
    ios/                    # Swift sources (registerView/registerService adapters)
    android/                # Kotlin sources (same plugin, Android host) — pending
  qr-scanner/
    lecodes-plugin.json
    ios/
    android/
  geolocation/              # "geolocation" service over CoreLocation (extracted from the
    lecodes-plugin.json     # SDK: linking CoreLocation makes Apple flag location usage,
    ios/                    # so only apps that install this plugin carry it)
  push/                     # "push" service: APNs machinery + le.codes relay registration
    lecodes-plugin.json
    ios/
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
- **One versioning story.** Repo-wide semver tags (`v0.1.0`); the lockfile records tag + commit.

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
  "version": "0.1.0",
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
    "entitlements": {                 // plist-typed JSON values (arrays allowed), e.g. the push
      "aps-environment": "development" // plugin's APNs capability. Declared for tooling; the CLI
    }                                 // does not merge these into shells yet (see push caveat).
  },
  "android": null                     // null = platform not supported yet
}
```

Naming rule: first-party plugins own bare channel names (`camera`, `qrScanner`); third-party
view/service names must be vendor-prefixed (`acme.bluetooth`).

### Plugins that need app-delegate moments (push)

A plugin cannot implement `UIApplicationDelegate` callbacks. The SDK (≥ 1.5.0) exposes
`LeCodesAppHooks` — a buffered forwarding surface the host app calls (`install()` in
`didFinishLaunching`, the APNs token callbacks, `connectionOptions.notificationResponse`
in scene connect); the generated shell templates include those lines, and the plugin
attaches its handler at `register(in:)` time. Buffering makes the ordering safe either way.

**Push delivery caveat:** the le.codes relay signs sends with the le.codes APNs key, which
can only reach the LeCodes launcher family's bundle ids. In a generated shell (own bundle
id, no world identity) `register()` rejects `"unavailable"` — honest, until the backend
supports per-app APNs keys. That's also why the CLI doesn't merge `entitlements` yet.

## JS side

The typed wrappers for these first-party plugins ship **in the SDK** (`CameraView`, `QRScanner`
globals) and tree-shake into any app bundle that references them, gated on
`isSupported` — installing a plugin here only adds the *native* half to the app shell.
