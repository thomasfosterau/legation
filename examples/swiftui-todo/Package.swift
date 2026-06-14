// swift-tools-version: 5.9
//
// A runnable SwiftUI example for the EffectSync Swift engine. SwiftUI requires
// an Apple toolchain, so this builds on macOS (or open it in Xcode); it is not
// part of the Linux CI. The engine library is consumed from the sibling package
// by path.

import PackageDescription

let package = Package(
    name: "swiftui-todo",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    dependencies: [
        .package(path: "../../packages/swift"),
    ],
    targets: [
        .executableTarget(
            name: "TodoApp",
            dependencies: [
                .product(name: "EffectSync", package: "swift"),
            ]
        ),
    ]
)
