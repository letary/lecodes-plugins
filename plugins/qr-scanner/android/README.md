# qr-scanner — Android

Pending. Kotlin sources land here as a local Gradle module the Android shell compiles
directly (same vendoring model as iOS — no Maven publishing). The adapter mirrors
`ios/QRScannerPlugin.swift` against the Android host's `engine.registerView("qrScanner")`,
emitting `scan { data }` events (`data: null` when the code leaves the frame).

When implemented, replace `"android": null` in ../lecodes-plugin.json with
`{ "sources": "android", "module": "lecodes-qr-scanner", "register": "...", "manifest": { ...permissions... } }`.
