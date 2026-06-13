// swift-tools-version: 5.9
//
// EffectSync — a Swift-native client port of the effect-sync engine's "Web"
// implementation (packages/core client modules + packages/browser).
//
// `EffectSync` is the platform-agnostic engine: it builds on every Swift
// platform (including Linux) using only Foundation + Swift Concurrency, so the
// rebase/journal/overlay logic is testable anywhere. `EffectSyncData` adds the
// durable SwiftData-backed ClientStore and compiles to an empty module where
// SwiftData is unavailable (see ADR-0012).

import PackageDescription

let package = Package(
    name: "EffectSync",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
        .tvOS(.v17),
        .watchOS(.v10),
    ],
    products: [
        .library(name: "EffectSync", targets: ["EffectSync"]),
        .library(name: "EffectSyncData", targets: ["EffectSyncData"]),
    ],
    targets: [
        .target(name: "EffectSync"),
        .target(name: "EffectSyncData", dependencies: ["EffectSync"]),
        .testTarget(name: "EffectSyncTests", dependencies: ["EffectSync"]),
    ]
)
