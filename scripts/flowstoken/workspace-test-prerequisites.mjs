export function testPrerequisites(testScript, workspace = "workspace") {
	return testScript
		.split(/\s*&&\s*/u)
		.slice(0, -1)
		.map((command) => {
			const match = command.trim().match(/^bun\s+(.+)$/u);
			if (!match) throw new Error(`${workspace}: unsupported test prerequisite "${command.trim()}"`);
			return match[1].trim().split(/\s+/u);
		});
}
