import Foundation
import PackagePlugin

@main
struct CompileLocalizations: BuildToolPlugin {
	func createBuildCommands(context: PluginContext, target: Target) async throws -> [Command] {
		let script = context.package.directoryURL.appendingPathComponent("scripts/compile-string-catalog.sh")
		let source = target.directoryURL.appendingPathComponent("Resources/Localizable.xcstrings")
		let output = context.pluginWorkDirectoryURL.appendingPathComponent("CompiledCatalog")
		return [.prebuildCommand(
			displayName: "Compile VettaKit localizations",
			executable: URL(fileURLWithPath: "/bin/sh"),
			arguments: [script.path, source.path, output.path],
			outputFilesDirectory: output
		)]
	}
}
