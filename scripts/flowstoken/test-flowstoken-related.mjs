#!/usr/bin/env node
// Runs every Vitest test that depends on a file FlowsToken changed relative to an upstream ref, per workspace.
//
// `vitest related` selects the suites importing the fork's changed files. Explicit release gates also
// exercise packaging, host access and remote process lifecycle contracts across their real boundaries.
//
// usage: node scripts/flowstoken/test-flowstoken-related.mjs <upstream-ref>
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { buildableTestDependencies, runBun, TESTABLE_PACKAGES } from "../quality/lib.mjs";

const ref = process.argv[2];
if (!ref) {
	console.error("usage: test-flowstoken-related.mjs <upstream-ref>");
	process.exit(64);
}

const changed = execFileSync("git", ["diff", "--name-only", "--diff-filter=AMR", ref, "HEAD"], { encoding: "utf8" })
	.split("\n")
	.filter((file) => /\.(ts|tsx|mts|js|mjs)$/.test(file) && existsSync(file));

/** Nearest ancestor directory with a package.json that has a `test` script. */
function workspaceOf(file) {
	for (let dir = dirname(file); dir !== "." && dir !== "/"; dir = dirname(dir)) {
		const pkg = join(dir, "package.json");
		if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).scripts?.test) return dir;
	}
	return undefined;
}

const byWorkspace = new Map();
for (const file of changed) {
	const ws = workspaceOf(file);
	if (!ws) continue;
	if (!byWorkspace.has(ws)) byWorkspace.set(ws, []);
	byWorkspace.get(ws).push(relative(ws, file));
}

// Build the workspace packages these suites import, exactly like `bun run test:pkg` does.
const packageNameByDir = new Map(Object.entries(TESTABLE_PACKAGES).map(([name, dir]) => [dir, name]));
const names = [...byWorkspace.keys()].map((dir) => packageNameByDir.get(dir)).filter(Boolean);
const buildDependencies = buildableTestDependencies(names);
if (buildDependencies.length > 0) {
	console.log(`[flowstoken-related] building workspace dependencies: ${buildDependencies.join(", ")}`);
	const code = runBun(["x", "turbo", "run", "build", ...buildDependencies.map((name) => `--filter=${name}`)]);
	if (code !== 0) process.exit(code);
}

// Any temporary exclusion needs reproducible evidence; fixed cases must return to the gate.
const known = JSON.parse(readFileSync("branding/flowstoken/tests/upstream-known-failures.json", "utf8")).excluded;

const runner = join(process.cwd(), "scripts/quality/run-vitest.mjs");
let failed = 0;
for (const [ws, files] of byWorkspace) {
	console.log(`\n[flowstoken-related] ${ws}: ${files.length} FlowsToken file(s)`);
	// Some upstream suites (git-backed marketplace fixtures) hit their own 5-10s timeouts when a thousand tests
	// share the runner. A longer default timeout plus two retries absorbs load jitter; a genuinely broken test
	// still fails all three attempts.
	const excludes = known.filter((k) => k.file.startsWith(`${ws}/`)).flatMap((k) => ["--exclude", relative(ws, k.file)]);
	for (const k of known.filter((k) => k.file.startsWith(`${ws}/`))) console.log(`[flowstoken-related] quarantined: ${k.file} (${k.reason})`);
	const args = [runner, "related", "--run", "--passWithNoTests", "--testTimeout=30000", "--retry=2", ...excludes, ...files];
	const result = spawnSync("bun", args, {
		cwd: ws,
		stdio: "inherit",
	});
	if (result.status !== 0) {
		failed++;
		console.error(`[flowstoken-related] ${ws} FAILED`);
	}
}
console.log(`\n[flowstoken-related] ${byWorkspace.size} workspace(s), ${failed} failed`);
process.exit(failed ? 1 : 0);
