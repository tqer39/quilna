// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Quilna",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "TextbookCore", targets: ["TextbookCore"]),
        .library(name: "TextbookUI", targets: ["TextbookUI"]),
        .executable(name: "Quilna", targets: ["Quilna"]),
    ],
    targets: [
        .target(
            name: "CSQLite",
            exclude: ["PROVENANCE.json"],
            sources: ["sqlite3.c"],
            publicHeadersPath: "include",
            cSettings: [
                .define("SQLITE_ENABLE_FTS5"),
                .define("SQLITE_THREADSAFE", to: "1"),
                .define("SQLITE_OMIT_LOAD_EXTENSION"),
            ]
        ),
        .target(name: "TextbookCore", dependencies: ["CSQLite"]),
        .target(name: "TextbookUI", dependencies: ["TextbookCore"]),
        .executableTarget(name: "Quilna", dependencies: ["TextbookUI"]),
        .testTarget(name: "TextbookCoreTests", dependencies: ["TextbookCore", "CSQLite"]),
        .testTarget(name: "TextbookUITests", dependencies: ["TextbookUI", "TextbookCore"]),
    ],
    swiftLanguageModes: [.v6]
)
