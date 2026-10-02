// swift-tools-version: 6.2
import PackageDescription

let isolation: [SwiftSetting] = [.defaultIsolation(MainActor.self)]

let package = Package(
	name: "VettaKit",
	defaultLocalization: "en",
	platforms: [.iOS(.v26), .macOS(.v26)],
	products: [
		.library(name: "VettaKit", targets: ["VettaKit"]),
	],
	targets: [
		.target(
			name: "VettaKit",
			// Native SwiftPM copies xcstrings unchanged; the plugin compiles standard locale
			// resources. Copying the source prevents Xcode from compiling it a second time.
			resources: [.copy("Resources/Localizable.xcstrings")],
			swiftSettings: isolation,
			linkerSettings: [.linkedLibrary("sqlite3")],
			plugins: [.plugin(name: "CompileLocalizations")]
		),
		.testTarget(name: "VettaKitTests", dependencies: ["VettaKit"], swiftSettings: isolation),
		.plugin(name: "CompileLocalizations", capability: .buildTool()),
	]
)
