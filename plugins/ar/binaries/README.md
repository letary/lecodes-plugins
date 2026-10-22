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
  (`lecodes app sync` copies it). A device binary links ~640 KB of it; the archive carries std's
  objects and some embedded bitcode, which is why it is larger.
- `../android/src/main/jniLibs/<abi>/libqr_anchor_jni.so` — the JNI library (`System.loadLibrary
  ("qr_anchor_jni")`), packed by the plugin's Gradle module as it is (default source sets) and
  vendored with the android/ folder by a shell. arm64-v8a is 16 KB page aligned.

Built from qr-anchor commit `543985d` (2026-10-22, crate 0.1.0, output layout 1, stride 28),
rustc 1.101.0-nightly (1a2c4797e 2026-10-21), Xcode 26.6, NDK 29.0.13113456 (minSdk 23),
cargo-ndk 4.1.2. The sha256 of each:

| file | bytes | sha256 |
|---|---:|---|
| `ios/QrAnchorFFI.xcframework/ios-arm64/libqr_anchor_ffi.a` | 2 887 752 | `cf22e48addad2b90218464d3169f7a5356bc7c2ef6ab0a3ab909e5c1a2dbba38` |
| `ios/QrAnchorFFI.xcframework/ios-arm64_x86_64-simulator/libqr_anchor_ffi.a` | 5 798 960 | `4708d4f634c7d1d56f1bf33e7101218f020256ea99d0f20eb92836111e078450` |
| `../android/src/main/jniLibs/arm64-v8a/libqr_anchor_jni.so` | 686 768 | `d7c1c48a10b91a993cea3088f97da7f76b0ccb3758024d0f1f22058c4efbad74` |
| `../android/src/main/jniLibs/armeabi-v7a/libqr_anchor_jni.so` | 527 440 | `cb8201dcea29aa416c2b74e359f9d3bdd37e756d8e7d83cacb29857e0c37da87` |

The web half's copy of the same library as wasm is ../web/qr-anchor (its own README).
