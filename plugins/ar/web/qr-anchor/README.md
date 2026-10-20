# qr-anchor (wasm)

The QR detector of the WebXR arm (`../qrAnchor.ts`): the metric pose of a QR code of known printed
size from a gray camera picture and the picture's intrinsics. GENERATED — never edited here: the
`--target web` output of `wasm-pack build crates/qr-anchor-wasm --target web --release` in the
qr-anchor repo (Research/qr-anchor, its README: the API, the marker frame, the output layout),
copied as it is: the glue `qr_anchor_wasm.js`, its types `qr_anchor_wasm.d.ts`, the module
`qr_anchor_wasm_bg.wasm` (the manifest's `web.resources.qrAnchorWasm`, fetched with the first code).

Built from qr-anchor commit `5343f906674da30e1eb818f335ea5f69db8d8456` (2026-10-20, crate 0.1.0,
output layout 1), wasm-pack 0.13.1, wasm-bindgen 0.2.129, rustc 1.97.0-nightly, simd128;
`node tools/check-wasm.mjs` passed on this build. `qr_anchor_wasm_bg.wasm`: 311 490 bytes, sha256
`c478b3d37dec247bce51cb2542b7bb6ccc13e22755e7c7cd904a56532fbc8eab`.
