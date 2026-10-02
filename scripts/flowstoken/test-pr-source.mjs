import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runBun } from "../quality/lib.mjs";
import { main as testChanged } from "../quality/test-changed.mjs";
import { testReleaseSource } from "./test-release-source.mjs";
import { testSshPlatform } from "./test-ssh-platform.mjs";

const marker = "branding/flowstoken/UPSTREAM_SYNCED";

function desktopVersionAt(ref, execute) {
	const manifest = JSON.parse(execute("git", ["show", `${ref}:apps/desktop/package.json`], { encoding: "utf8" }));
	if (typeof manifest?.version !== "string" || !manifest.version.trim())
		throw new Error(`Invalid desktop version at ${ref}`);
	return manifest.version;
}

/** Upstream syncs and release preparation validate their complete source before merging. */
export function testPrSource(
	base,
	{
		execute = execFileSync,
		read = () => readFileSync(marker, "utf8").trim(),
		changed = testChanged,
		run = runBun,
		ssh = testSshPlatform,
		platform = process.platform,
	} = {},
) {
	if (!base) throw new Error("A concrete PR base is required");
	const mergeBase = execute("git", ["merge-base", "HEAD", base], { encoding: "utf8" }).trim();
	const previous = execute("git", ["show", `${mergeBase}:${marker}`], { encoding: "utf8" }).trim();
	const current = read();
	if (previous === current && desktopVersionAt(mergeBase, execute) === desktopVersionAt("HEAD", execute))
		return changed(["--base", base]);
	if (!/^v\d+\.\d+\.\d+$/.test(current)) throw new Error("Invalid upstream version marker");
	const ref = `refs/tags/upstream/${current}`;
	execute(
		"git",
		["fetch", "--no-tags", "https://github.com/openvetta/open-vetta.git", `refs/tags/${current}:${ref}`],
		{ stdio: "inherit" },
	);
	// Both sync and release preparation require the actual published upstream baseline.
	execute("git", ["merge-base", "--is-ancestor", ref, "HEAD"], { stdio: "inherit" });
	if (previous === current) {
		// PR checkout is GitHub's merge commit; bind the existing release gate to that source, not headRefOid.
		const sourceSha = execute("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		console.info(`[pr-source] desktop version changed; complete release client tests for ${sourceSha}`);
		return testReleaseSource(`upstream/${current}`, sourceSha, { execute, run, platform });
	}
	console.info(
		`[pr-source] verified upstream ${previous} -> ${current}; all workspace tests and native SSH contracts`,
	);
	const result = run(["run", "test:full"]);
	return result === 0 ? ssh() : result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = testPrSource(process.argv[2]);
	} catch (error) {
		console.error(`[pr-source] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
