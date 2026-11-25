import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { packagesFromPaths, runBun, TESTABLE_PACKAGES } from "../quality/lib.mjs";
import { assertReleaseSourceEligible } from "./release-source-policy.mjs";
import { selectSshPlatformSuites, testSshPlatform } from "./test-ssh-platform.mjs";

// These whole workspaces cover the client, AI requests, storage and remote execution even when
// the current fork diff is empty. SSH transport has no package test script and runs separately.
export const REQUIRED_CLIENT_TEST_PACKAGES = ["ai", "desktop", "runtime-node", "runtime-storage", "coding-agent"];

export function releaseSourceTestPackages(files) {
	const touched = packagesFromPaths(files).filter((name) => Object.hasOwn(TESTABLE_PACKAGES, name));
	return [...new Set([...REQUIRED_CLIENT_TEST_PACKAGES, ...touched])].sort();
}

export function testReleaseSource(ref, expectedSha, { execute = execFileSync, run = runBun, platform = process.platform } = {}) {
	assertReleaseSourceEligible(expectedSha);
	if (execute("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== expectedSha)
		throw new Error("Release quality checkout differs from the application source SHA");
	if (!/^upstream\/v\d+\.\d+\.\d+$/.test(ref ?? ""))
		throw new Error("An explicit upstream version baseline is required");
	const files = execute("git", ["diff", "--name-only", "--diff-filter=AMRD", ref, "HEAD", "--"], { encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
	// ssh-transport 的测试按设计只属于 SSH 平台契约门（见上注释与
	// testSshPlatform）：portable/posix 套件由契约门按平台正确选择，
	// posix 套件在 win32 上按设计抛错。包级矩阵若包含它，win32 必挂
	// 且与契约门重复覆盖，故在此剔除。
	const packages = releaseSourceTestPackages(files).filter((name) => name !== "ssh-transport");
	selectSshPlatformSuites(platform);
	console.info(
		`[release-source] ${expectedSha}; complete client workspaces: ${packages.join(", ")}; complete SSH platform contract: ${platform}`,
	);
	const workspaces = run(["run", "test:pkg", ...packages]);
	if (workspaces !== 0) return workspaces;
	return testSshPlatform({ platform, run });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = testReleaseSource(process.argv[2], process.argv[3]);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
