import { defineConfig } from "vitest/config";

// POSIX 契约套件（loopback/posix/e2e/signals）在 win32 上按设计抛错——
// 它们归 release SSH 平台契约门所有，该门在 win32 改选桌面端契约套件。
// 包级矩阵在 win32 必须排除它们，linux/macOS 行为不变。
const POSIX_ONLY = [
	"src/helper.e2e.test.ts",
	"src/remote-command.posix.test.ts",
	"src/remote-command-signals.test.ts",
	"src/remote-listeners.posix.test.ts",
	"src/ssh-connection.loopback.test.ts",
];

export default defineConfig({
	test: {
		exclude: [
			"**/node_modules/**",
			...(process.platform === "win32" ? POSIX_ONLY : []),
		],
	},
});
