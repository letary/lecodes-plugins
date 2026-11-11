# qr-anchor (native)

The QR detector of the native halves: the metric pose of a QR code of known printed size from a
grey camera plane and the camera's intrinsics — qr-anchor's C ABI (`crates/qr-anchor-ffi`,
`include/qr_anchor.h`: `qra_process_plane` over a luma plane of any stride, downsampled inside)
for iOS, and its JNI face (`crates/qr-anchor-jni`, the Kotlin class `io.letary.qranchor.QrAnchor`
of ../android/src/main/java/io/letary/qranchor/QrAnchor.kt) for Android. GENERATED — never
edited here: the output of `tools/build-ios.sh` and `tools/build-android.sh` in the qr-anchor repo
(Ingenuity/qr-anchor, its README: the API, the marker frame, the output layout), copied as it is:

- `ios/QrAnchorFFI.xcframework` — the static library + `Headers/QrAnchorFFI/{qr_anchor.h,
  module.modulemap}` per slice (`import QrAnchorFFI`); the manifest's `ios.binaries` names it, so
  it is a binary target of the plugin repo's Package.swift and of a shell's LeCodesRuntime
  (`lecodes app sync` copies it). Built for size, since the viewer's App Clip links it and an App
  Clip's size is capped: std rebuilt from source and LTO'd in, `panic = immediate-abort`, opt-level
  `z` but the per-frame code at 3 (the qr-anchor README has the numbers). A device binary links
  197 KB of it (492 KB before 2026-11-12). The price: a panic in the core aborts the app instead
  of becoming an error return of the C ABI.
- `../android/src/main/jniLibs/<abi>/libqr_anchor_jni.so` — the JNI library (`System.loadLibrary
  ("qr_anchor_jni")`), packed by the plugin's Gradle module as it is (default source sets) and
  vendored with the android/ folder by a shell. arm64-v8a is 16 KB page aligned. Built for size
  the same way as the iOS library: 275 KB / 223 KB (687 / 527 KB before 2026-11-12), the same
  JNI exports, libdl no longer NEEDED (only std's backtrace printer used it). The same price: a
  panic in the core aborts the app instead of returning the JNI layer's error value.

Both built from qr-anchor commit `1812034` (2026-10-23, crate 0.1.1, output layout 1, stride 28)
plus its size changes (the `release-mobile` profile, json.rs's type-only error messages, the
build scripts' nightly + `-Zbuild-std` + immediate-abort recipe), on 2026-11-12.
iOS: rustc 1.102.0-nightly (9c5648833 2026-11-10), Xcode 27.2, IPHONEOS_DEPLOYMENT_TARGET 15.0.
Android: rustc 1.97.0-nightly (913e4bea8 2026-04-22), NDK 29.0.13113456 (minSdk 23), cargo-ndk
4.1.2. The sha256 of each:

| file | bytes | sha256 |
|---|---:|---|
| `ios/QrAnchorFFI.xcframework/ios-arm64/libqr_anchor_ffi.a` | 435 632 | `a3fb6005be3b3bf8fd29c200bb5dafa6e2f686f0d51be42cbd6b64f8b3e07f1b` |
| `ios/QrAnchorFFI.xcframework/ios-arm64_x86_64-simulator/libqr_anchor_ffi.a` | 950 320 | `78db817d00d8b5990548dbf9fa8a1c8dcde65e653c6d552a975e0e04d533697e` |
| `../android/src/main/jniLibs/arm64-v8a/libqr_anchor_jni.so` | 274 632 | `a1a60ca23b27a0247520609f4ff1b8a683ab23b63d26186e0eed70799ea630b9` |
| `../android/src/main/jniLibs/armeabi-v7a/libqr_anchor_jni.so` | 222 892 | `99e61b215dfb57df5eefd8ee57ab252f2dfcff1330438f72344b36bf2f5d5575` |

The web half's copy of the same library as wasm is ../web/qr-anchor (its own README).
