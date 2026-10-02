import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runBun } from "../quality/lib.mjs";
import { main as testChanged } from "../quality/test-changed.mjs";
import { testSshPlatform } from "./test-ssh-platform.mjs";

const marker = "branding/flowstoken/UPSTREAM_SYNCED";

/** A verified upstream merge runs every workspace rather than guessing deleted-file dependencies. */
export function testPrSource(
	base,
	{
		execute = execFileSync,
		read = () => readFileSync(marker, "utf8").trim(),
		changed = testChanged,
		run = runBun,
		ssh = testSshPlatform,
	} = {},
) {
	if (!base) throw new Error("A concrete PR base is required");
	const mergeBase = execute("git", ["merge-base", "HEAD", base], { encoding: "utf8" }).trim();
	const previous = execute("git", ["show", `${mergeBase}:${marker}`], { encoding: "utf8" }).trim();
	const current = read();
	if (previous === current) return changed(["--base", base]);
	if (!/^v\d+\.\d+\.\d+$/.test(current)) throw new Error("Invalid upstream version marker");
	const ref = `refs/tags/upstream/${current}`;
	execute(
		"git",
		["fetch", "--no-tags", "https://github.com/openvetta/open-vetta.git", `refs/tags/${current}:${ref}`],
		{ stdio: "inherit" },
	);
	// A marker edit alone cannot enable the full-sync path; require the actual published merge.
	execute("git", ["merge-base", "--is-ancestor", ref, "HEAD"], { stdio: "inherit" });
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
