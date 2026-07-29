# camera — Android

Pending. Kotlin sources land here as a local Gradle module the Android shell compiles
directly (same vendoring model as iOS — no Maven publishing). The adapter mirrors
`ios/CameraPlugin.swift` against the Android host's `engine.registerView("camera")`
(see creator-pkg's Android bridge), emitting the same channel shapes:
`takePhoto` → `{ systemId, name, size }`, `setFacingMode("front"|"back")`.

When implemented, replace `"android": null` in ../lecodes-plugin.json with
`{ "sources": "android", "module": "lecodes-camera", "register": "...", "manifest": { ...permissions... } }`.
