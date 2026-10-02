import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { packagesFromPaths, runBun, TESTABLE_PACKAGES } from "../quality/lib.mjs";
import { assertReleaseSourceEligible } from "./release-source-policy.mjs";

// These whole workspaces cover the client, remote runtime and conversation execution even when
// the current fork diff is empty. SSH transport has no package test script and runs separately.
export const REQUIRED_CLIENT_TEST_PACKAGES = ["desktop", "runtime-node", "coding-agent"];

export function releaseSourceTestPackages(files) {
	const touched = packagesFromPaths(files).filter((name) => Object.hasOwn(TESTABLE_PACKAGES, name));
	return [...new Set([...REQUIRED_CLIENT_TEST_PACKAGES, ...touched])].sort();
}

export function testReleaseSource(ref, expectedSha, { execute = execFileSync, run = runBun } = {}) {
	assertReleaseSourceEligible(expectedSha);
	if (execute("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== expectedSha)
		throw new Error("Release quality checkout differs from the application source SHA");
	if (!/^upstream\/v\d+\.\d+\.\d+$/.test(ref ?? ""))
		throw new Error("An explicit upstream version baseline is required");
	const files = execute("git", ["diff", "--name-only", "--diff-filter=AMRD", ref, "HEAD", "--"], { encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
	const packages = releaseSourceTestPackages(files);
	console.info(
		`[release-source] ${expectedSha}; complete client workspaces: ${packages.join(", ")}; all SSH transport suites`,
	);
	const workspaces = run(["run", "test:pkg", ...packages]);
	if (workspaces !== 0) return workspaces;
	return run(["scripts/quality/run-vitest.mjs", "--run", "packages/ssh-transport/src"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = testReleaseSource(process.argv[2], process.argv[3]);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
