# lecodes-plugins

First-party native plugins of LeCodes apps, for the 2.x SDK: iOS, Android and the web.

> **Status: in progress.** The contracts, the manifests, the app's side (`sdk/`) and the halves
> (`ios/`, `android/`, `web/`) are here. The 1.x plugins live in
> [lecodes-plugins-legacy](https://github.com/letary/lecodes-plugins-legacy).

Desktop plugins are a separate system (a prebuilt library behind a C ABI) and are not part of this
repo.

## What a plugin is

A capability an app reaches the same way on every platform, through one of two channels:

| channel | for | app side |
|---|---|---|
| **View** | it draws its own pixels: a camera preview, a map | a view the app opens fullscreen or embeds |
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
- A contract describes the WIRE. The API an app sees (the wrapper in `sdk/`) may be higher: the
  map's wrapper turns marker items into GeoJSON and queues calls until the style has loaded.

| type | meaning |
|---|---|
| `i32`, `f64`, `boolean`, `string` | scalars; a number that is not finite is a null on the wire |
| `Uint8Array` | bytes, as they are — no text in between: `Data` in Swift, `ByteArray` in Kotlin |
| `File` | bytes that stay in the host; what crosses is a handle (a texture, an upload, a share) — either way |
| `Json` | any JSON value, passed through untyped (GeoJSON, a developer's payload) |
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
    "dependencies": ["org.maplibre.gl:android-sdk:13.6.0"]
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
- iOS: `infoPlist` (usage strings), `entitlements`, `packages`. Android: `dependencies` (Maven; a
  `platform:` prefix is a BoM), `gradlePlugins`; permissions and services are the half's own
  `AndroidManifest.xml`. Web: `dependencies` (npm), `resources` — what the half asks of its bundler,
  handed to `register` under these names, so the half names no bundler.
- `lecodes plugin gen` holds the manifest to the plugin's folders.

## Plugins

| id | channel | name | web |
|---|---|---|---|
| `camera` | view | `camera` | yes |
| `qr-scanner` | view | `qrScanner` | yes, where the browser has `BarcodeDetector` |
| `map` | view | `map` | yes |
| `geolocation` | service | `geolocation` | yes |
| `push` | service | `push` | no |

## Naming

First-party plugins own bare channel names (`camera`). A third-party plugin prefixes its names with
its vendor: `acme.bluetooth`.
