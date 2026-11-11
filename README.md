# lecodes-plugins

First-party native plugins of LeCodes apps, for the 2.x SDK: iOS, Android and the web.

> **Status: in progress.** The contracts, the manifests, the app's side (`sdk/`) and the halves
> (`ios/`, `android/`, `web/`) are here. The 1.x plugins live in
> [lecodes-plugins-legacy](https://github.com/letary/lecodes-plugins-legacy).

Desktop plugins are a separate system (a prebuilt library behind a C ABI) and are not part of this
repo.

## What a plugin is

A capability an app reaches the same way on every platform, through one of three channels:

| channel | for | app side |
|---|---|---|
| **View** | it draws its own pixels, fullscreen: a camera, a map | a destination the app opens or pushes, widgets over it — never a part of a screen |
| **Host node** | it draws its own pixels in a box of a screen's layout: a map in a card, a preview tile | a node among a screen's children (`UIHostNode`), props, events, no children |
| **Service** | no pixels: a position, notifications | calls and events |

An app never branches on the platform, only on `isSupported`.

## Layout

One plugin per directory; a folder is a DESTINATION:

```
plugins/<id>/
  lecodes-plugin.json     the manifest: what a host needs to build the plugin in
  contract.d.ts           the contract of the channel — the source of truth
  sdk/                    → the app's bundle: the wrapper the app calls (TypeScript source)
  ios/                    → the iOS shell (Swift)
  android/                → the Android shell (Kotlin), laid out as a Gradle module:
                            src/main/AndroidManifest.xml, src/main/java/<package>/, src/main/res/, libs/
  web/                    → the web host (TypeScript)
```

Generated files sit beside the hand-written ones and end in `.gen.*` (on Android: in the folder of
the plugin's Kotlin package). They are committed:

```sh
lecodes plugin gen            # write them
lecodes plugin gen --check    # fail on a stale one (CI)
```

The generator reads a contract with the `typescript` package (5.x; TypeScript 6 is ESM-only and is
not read): the plugin's own, looked up from its folder upwards, else the one next to the CLI's
install — a dependency of `lecodes-cli` after 2.4.9, so a bun / npm install of the CLI brings it. A
standalone binary of the CLI carries none: give the plugin's repo `typescript@^5.8.3` as a dev
dependency (this repo does), or `bun add -g "typescript@^5.8.3"` next to a bun-installed CLI.

`Package.swift` at the root is generated too: the iOS halves as one SwiftPM package — a target and a
product per plugin (the manifest's `ios.module`, its `ios.packages` as dependencies, a binary target
per `ios.binaries` xcframework). Each plugin is its own module, so two plugins may name a type alike,
and an Xcode project links a plugin as a product instead of compiling its folder. The SDK the
package depends on is the LeCodes package on disk: `LECODES_IOS_SDK_PATH`, else what this repo's
`package.json` names under `lecodes.iosSdkPath` (`../apple/lecodes`: this repo is a submodule of
LeCodes core at `hosts/plugins`), else the sibling `../lecodes`. A shell made by `lecodes app sync`
vendors the sources into its own targets instead.

`sdk/<id>.ts` is the hand-written part of the wrapper, and optional: without it the generated file
exports the public API itself — the wire's methods and a typed `on(event, …)`.

## The contract

Three interfaces per channel — the methods, the params, the events:

```ts
import type { File, View } from "lecodes-sdk/plugin"

export type Facing = "front" | "back"
export interface CameraParams { facingMode?: Facing }
export interface CameraEvents { error: { message: string } }

export interface CameraView extends View<"camera", CameraParams, CameraEvents> {
  /** @rejects failed */
  takePhoto(): Promise<File>
  setFacingMode(mode: Facing): Promise<void>
}
```

- `View<name, Params, Events>` / `Service<name, Params, Events>` mark the channel; `name` is what
  the halves register under.
- An event maps its name to its payload; `void` = no payload.
- `@rejects` lists the codes a call can fail with. `@since <n>` marks a method added in version
  `n` of the contract: a half registers with the version it was generated from, and an app asks
  `supports("<method>")` before it calls one a host's half may be too old for.
- `@permission <kind…>` (`camera`, `microphone`, `location`, `speech`) names the OS permissions a
  call needs. The generated native glue asks the host's one permission service before the call and
  rejects with `denied` when one was refused — the half never sees a dialog (the web half asks
  nothing: the browser's API prompts itself). `lecodes plugin gen` holds the manifests to it: the
  usage string in `ios.infoPlist`, the `<uses-permission>` in the Android manifest. A call whose
  need depends on its arguments (webrtc's `getUserMedia`) asks by hand through the same service
  (`engine.permissions.ensure`). A view that needs a permission to mount asks in its wrapper
  (`prepareCamera`), through the SDK's `permissions`.
- `@lazy` on an event of a View or a Service: the half sends it only while the app has a listener
  of it — for an event that ticks (a position, a level), so that nothing calls into the app when
  nobody listens. Nothing is written by hand for it. The wrapper's base counts the listeners and
  tells the half when the first one comes and the last one goes (the wire's own call,
  `$listen(event, on)`), and again each time the half's instance is made — a service's session
  opens on its first call, a view's instance lives while it is presented, the listeners outlive
  both. The generated glue hands that to the plugin as `<event>Observed(observed)`, which starts
  and stops what produces the event (and sends the value it has, so a new listener is not left
  waiting for the next tick), keeps `events.<event>Observed` for a half that would rather not
  build a payload, and drops an event sent while nobody listens. The end of the session (`close`)
  or of the instance (`destroy`) stops everything without a last `<event>Observed(false)`.
  Tag an event when it is added: a bundle built before the tag never says it listens, so tagging
  an event apps already hear takes it from them. A host node's event is not `@lazy`.
- A contract describes the WIRE. The API an app sees (the wrapper in `sdk/`) may be higher: the
  map's wrapper turns marker items into GeoJSON and queues calls until the style has loaded.

| type | meaning |
|---|---|
| `i32`, `f64`, `boolean`, `string` | scalars; a number that is not finite is a null on the wire |
| `Uint8Array` | bytes, as they are — no text in between: `Data` in Swift, `ByteArray` in Kotlin |
| `File` | bytes that stay in the host; what crosses is a handle (a texture, an upload, a share) — either way |
| `Json` | any JSON value, passed through untyped (GeoJSON, a developer's payload) |
| `Entity`, `Scene3D` | the app's 3D node / scene, its id on the wire: the half drives it through the host's gl facade (`engine.gl` / `host.gl` — matrices, a scene's camera, projection and background, the scene view's size and turn, a hook before each frame), never creating or freeing it; a `Scene3D` only goes from the app to the host |
| a union of string literals | an enum |
| `interface`, `T[]`, `[A, B]`, `T \| null`, `key?:` | a struct, a list, a tuple, a nullable, an optional |

## The manifest

`lecodes-plugin.json` says what a host needs to BUILD the plugin in — never what the plugin does
(that is the contract) nor where its code is (that is the folders):

```json
{
  "id": "map",
  "name": "Map",
  "version": "2.0.0",
  "sdk": "^2.0.0",
  "ios": {
    "register": "LeCodesMapPlugin",
    "packages": [{ "url": "https://github.com/maplibre/maplibre-gl-native-distribution", "exact": "6.29.0", "products": ["MapLibre"] }]
  },
  "android": {
    "register": "io.letary.lecodes.plugins.map.LeCodesMapPlugin",
    "dependencies": ["org.maplibre.gl:android-sdk-opengl:13.6.0"]
  },
  "web": {
    "register": "web/map.ts",
    "dependencies": { "maplibre-gl": "^6.7.0" },
    "resources": {
      "workerUrl": { "module": "maplibre-gl/dist/maplibre-gl-worker.mjs", "as": "worker-url" },
      "css": { "module": "maplibre-gl/dist/maplibre-gl.css", "as": "text" }
    }
  }
}
```

- A platform is ALWAYS a key: an object where the plugin has a half, `null` where it has none.
- `register` is the hand-written type a host calls: `static func register(in:)` on iOS,
  `fun register(engine, context)` on Android, the module that exports `register(host)` on the web.
- iOS: `infoPlist` (usage strings), `entitlements`, `packages`, `binaries` — prebuilt
  xcframeworks of the plugin's folder by their paths in it (`["binaries/ios/QrAnchorFFI.xcframework"]`),
  never under `ios/`: each is a binary target named after its folder (`QrAnchorFFI`, one name per
  package — two plugins may not carry one alike) that the half's target links; a shell copies it
  beside the vendored sources. Android: `dependencies` (Maven; a
  `platform:` prefix is a BoM), `gradlePlugins`; `<uses-permission>` and services are the half's own
  `AndroidManifest.xml`. Web: `dependencies` (npm), `resources` — what the half asks of its bundler,
  handed to `register` under these names (a function: nothing is fetched before the half asks), so
  the half names no bundler. A resource's `module` is a file of a dependency
  (`maplibre-gl/dist/maplibre-gl.css`) or, starting with `./`, a file of the plugin's own folder
  (`ar`: `./web/qrAnchorWorker.ts` as `worker-url`, its QR detector's worker — the wasm it loads,
  a blob committed beside the half, is an asset the bundler emits with it).
- `lecodes plugin gen` holds the manifest to the plugin's folders.

## Plugins

| id | channel | name | web |
|---|---|---|---|
| `camera` | view | `camera` | yes |
| `qr-scanner` | view | `qrScanner` | yes, where the browser has `BarcodeDetector` |
| `map` | view | `map` | yes |
| `geolocation` | service | `geolocation` | yes |
| `audio-recorder` | service | `audioRecorder` | yes: the browser's MediaRecorder (webm/opus, mp4 in Safari) |
| `speech` | service | `speech` | yes, where the browser has `SpeechRecognition` (Chrome, Safari) |
| `push` | service | `push` | no |
| `browser` | service + view | `browser`, `webView` | yes: a popup, an iframe (own-origin pages) |
| `webrtc` | service + view | `rtcMedia`, `rtcPeerConnection`, `rtcVideo` | yes: the browser's own WebRTC |
| `ar` | service | `ar` | yes: WebXR where Chrome has it (ARCore: hit tests, anchors, QR codes — qr-anchor's wasm), else the camera under the scene, turned by the sensors (no planes, no images) |

## Naming

First-party plugins own bare channel names (`camera`). A third-party plugin prefixes its names with
its vendor: `acme.bluetooth`.
