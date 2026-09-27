# lecodes-plugins

First-party native plugins of LeCodes apps, for the 2.x SDK: iOS, Android and the web.

> **Status: in progress.** The contracts, the app's side (`sdk/`) and the iOS halves (`ios/`) are
> here; `android/` and `web/` are not yet. The 1.x plugins live in
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
  lecodes-plugin.json     the manifest: ios / android / web, null = not supported
  contract.d.ts           the contract of the channel — the source of truth
  sdk/                    → the app's bundle: the wrapper the app calls (TypeScript source)
  ios/                    → the iOS shell (Swift)
  android/                → the Android shell (Kotlin)
  web/                    → the web host (TypeScript)
```

Generated files sit beside the hand-written ones and end in `.gen.*`. They are committed:

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
  `n` of the contract.
- A contract describes the WIRE. The API an app sees (the wrapper in `sdk/`) may be higher: the
  map's wrapper turns marker items into GeoJSON and queues calls until the style has loaded.

| type | meaning |
|---|---|
| `i32`, `f64`, `boolean`, `string` | scalars |
| `Uint8Array` | bytes the app reads |
| `File` | bytes that stay in the host; the app gets a handle (a texture, an upload, a share) |
| `Json` | any JSON value, passed through untyped (GeoJSON, a developer's payload) |
| a union of string literals | an enum |
| `interface`, `T[]`, `[A, B]`, `T \| null`, `key?:` | a struct, a list, a tuple, a nullable, an optional |

## Plugins

| id | channel | name | web |
|---|---|---|---|
| `camera` | view | `camera` | yes |
| `qr-scanner` | view | `qrScanner` | planned |
| `map` | view | `map` | yes |
| `geolocation` | service | `geolocation` | yes |
| `push` | service | `push` | no |

## Naming

First-party plugins own bare channel names (`camera`). A third-party plugin prefixes its names with
its vendor: `acme.bluetooth`.
