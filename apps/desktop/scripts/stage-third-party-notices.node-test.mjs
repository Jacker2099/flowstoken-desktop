import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { stageThirdPartyNotices, THIRD_PARTY_NOTICE_FILES } from "./stage-third-party-notices.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

test("the distributed notices retain the original LICENSE and NOTICE bytes and attribution", () => {
	const directory = mkdtempSync(join(tmpdir(), "flowstoken-notices-"));
	try {
		stageThirdPartyNotices({ repositoryRoot, destinationDir: join(directory, "third-party-notices") });
		for (const name of THIRD_PARTY_NOTICE_FILES) {
			const original = readFileSync(join(repositoryRoot, name));
			assert.deepEqual(readFileSync(join(directory, "third-party-notices", name)), original);
		}
		const notice = readFileSync(join(directory, "third-party-notices", "NOTICE"), "utf8");
		assert.match(notice, /Open Vetta/);
		assert.match(notice, /Mario Zechner/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("missing or empty originals stop staging rather than distribute incomplete attribution", () => {
	for (const kind of ["missing", "empty"]) {
		const directory = mkdtempSync(join(tmpdir(), "flowstoken-missing-notices-"));
		try {
			const source = join(directory, "source");
			mkdirSync(source);
			writeFileSync(join(source, "LICENSE"), "license fixture\r\n");
			if (kind === "empty") writeFileSync(join(source, "NOTICE"), "");
			const destinationDir = join(directory, "third-party-notices");
			assert.throws(
				() => stageThirdPartyNotices({ repositoryRoot: source, destinationDir }),
				/attribution file.*NOTICE/,
			);
			assert.equal(existsSync(destinationDir), false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});

test("all platform packages expose the staged originals under Resources/third-party-notices", () => {
	const source = readFileSync(join(import.meta.dirname, "prepare-pack.js"), "utf8");
	assert.match(
		source,
		/stageThirdPartyNotices\(\{\s*repositoryRoot: join\(projectRoot, "\.\.", "\.\."\),\s*destinationDir: join\(buildStageDir, "third-party-notices"\),\s*\}\)/,
	);
	const factory = source.match(/^function resolveExtraResources\(\) \{[\s\S]*?^\}/m)?.[0];
	assert.ok(factory, "Packaging resource configuration is unavailable");
	for (const platform of ["darwin", "win32", "linux"]) {
		const resources = runInNewContext(`${factory}; resolveExtraResources()`, {
			resolvePlatformFamilies: () => new Set([platform]),
			resolveBuildResourceFilters: () => [],
			resolveSandboxResourceFilters: () => [],
			speechInputBuildConfig: { enabled: false },
			process: { platform },
		});
		const notices = resources.find((entry) => entry.to === "third-party-notices");
		assert.ok(notices, `${platform} package omitted its notice resources`);
		assert.equal(notices.from, "third-party-notices");
		assert.deepEqual([...notices.filter], [...THIRD_PARTY_NOTICE_FILES]);
	}
});
