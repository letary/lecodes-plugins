# qr-anchor (wasm)

The QR detector of the WebXR arm (`../qrAnchor.ts`): the metric pose of a QR code of known printed
size from a gray camera picture and the picture's intrinsics. GENERATED — never edited here: the
`--target web` output of `wasm-pack build crates/qr-anchor-wasm --target web --release` in the
qr-anchor repo (Research/qr-anchor, its README: the API, the marker frame, the output layout),
copied as it is: the glue `qr_anchor_wasm.js`, its types `qr_anchor_wasm.d.ts`, the module
`qr_anchor_wasm_bg.wasm` (loaded by the detector's worker, `../qrAnchorWorker.ts` — the manifest's
`web.resources.qrAnchorWorker` — with the first code; the bundler emits it beside the worker).

Built from qr-anchor commit `2524f8a` (2026-10-20, crate 0.1.0, an empty target text = any code,
output layout 1), wasm-pack 0.13.1, wasm-bindgen 0.2.129, rustc 1.97.0-nightly, simd128;
`node tools/check-wasm.mjs` passed on this build. `qr_anchor_wasm_bg.wasm`: 311 499 bytes, sha256
`2edac25f42b3ba886004639488c7e5b75bf18cec1ba6b5f09f345a9ed36cdaec`.
