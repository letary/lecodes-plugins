// swift-tools-version:5.9
//
// DEV MANIFEST ONLY — apps never depend on this package. The lecodes CLI vendors
// plugins/<id>/ios into the app shell's local AppShell package instead (see README).
// This manifest exists so plugin sources can be opened in Xcode and built/tested
// against the published SDK. Build with an iOS destination; the SDK binary has no
// macOS slice.

import PackageDescription

let package = Package(
    name: "lecodes-plugins",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "LeCodesCamera", targets: ["LeCodesCamera"]),
        .library(name: "LeCodesQRScanner", targets: ["LeCodesQRScanner"]),
        .library(name: "LeCodesGeolocation", targets: ["LeCodesGeolocation"]),
        .library(name: "LeCodesPush", targets: ["LeCodesPush"]),
    ],
    dependencies: [
        // geolocation/push need the 1.5.0 hook surface (LeCodesAppHooks, public onMainThread).
        // Until that release is published, develop these sources through the launcher repo's
        // vendoring (`LeCodes IOS/scripts/sync-plugins.sh`) instead of this manifest.
        .package(url: "https://github.com/letary/lecodes-ios-sdk.git", from: "1.5.0"),
    ],
    targets: [
        .target(
            name: "LeCodesCamera",
            dependencies: [.product(name: "LeCodesSDK-core", package: "lecodes-ios-sdk")],
            path: "plugins/camera/ios"
        ),
        .target(
            name: "LeCodesQRScanner",
            dependencies: [.product(name: "LeCodesSDK-core", package: "lecodes-ios-sdk")],
            path: "plugins/qr-scanner/ios"
        ),
        .target(
            name: "LeCodesGeolocation",
            dependencies: [.product(name: "LeCodesSDK-core", package: "lecodes-ios-sdk")],
            path: "plugins/geolocation/ios"
        ),
        .target(
            name: "LeCodesPush",
            dependencies: [.product(name: "LeCodesSDK-core", package: "lecodes-ios-sdk")],
            path: "plugins/push/ios"
        ),
    ]
)
