import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
	resolvePackagedE2eAppImagePath,
	resolvePackagedE2eBinaryPath,
} from "../../../apps/desktop/scripts/packaged-e2e-binary.mjs";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(join(root, "apps/desktop/package.json"));
const { parse } = require("yaml");
const smoke = parse(readFileSync(join(root, ".github/workflows/desktop-packaged.yml"), "utf8")).jobs.smoke;
const build = smoke.steps.find((step) => step.name === "Build unpacked Desktop package");
const e2e = smoke.steps.find((step) => step.name === "Run packaged Electron smoke and updater E2E");
const brand = {
	VETTA_PRODUCT_NAME: "FlowsToken",
	VETTA_EXECUTABLE_NAME: "FlowsToken",
	VETTA_APP_ID: "com.flowstoken.desktop",
};

function fixture(run) {
	const directory = mkdtempSync(join(tmpdir(), "flowstoken-pr-preflight-"));
	try {
		return run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("PR packaging and smoke tests share the FlowsToken product identity and explicit update fixture", () => {
	for (const [key, value] of Object.entries(brand)) assert.equal(smoke.env?.[key], value);
	for (const step of [build, e2e]) {
		const effective = { ...smoke.env, ...step.env };
		for (const [key, value] of Object.entries(brand)) assert.equal(effective[key], value);
		assert.equal(effective.VETTA_BUILD_ENV, "test");
		assert.equal(effective.VETTA_SPEECH_INPUT_ENABLED, "false");
	}
	assert.equal(e2e.env.VETTA_E2E_PACKAGED, "1");
	assert.equal(e2e.env.VETTA_E2E_UPDATE_FEED, "1");
	assert.notEqual(e2e["continue-on-error"], true);
	assert.match(e2e.run, /bun run test:e2e(?:\s|$)/);
	assert.doesNotMatch(e2e.run, /test:e2e:packaged|\|\|/);
	assert.equal(smoke.steps.find((step) => step.name === "Upload packaged diagnostics on failure").if, "failure()");
});

test("the PR test environment resolves the newly branded Windows, Mac and Linux packages", () =>
	fixture((directory) => {
		const files = {
			win32: join(directory, "release/win-unpacked/versions/0.6.3/FlowsToken.exe"),
			darwin: join(directory, "release/mac-arm64/FlowsToken.app/Contents/MacOS/FlowsToken"),
			linux: join(directory, "release/linux-unpacked/FlowsToken"),
		};
		for (const path of Object.values(files)) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "packaged executable fixture");
		}
		writeFileSync(join(directory, "release/win-unpacked/current.json"), JSON.stringify({ version: "0.6.3" }));
		writeFileSync(join(directory, "release/FlowsToken-0.6.3.AppImage"), "AppImage fixture");
		const previous = Object.fromEntries(Object.keys(brand).map((key) => [key, process.env[key]]));
		try {
			for (const key of Object.keys(brand)) delete process.env[key];
			Object.assign(
				process.env,
				smoke.env,
				Object.fromEntries(Object.entries(e2e.env).filter(([key]) => key in brand)),
			);
			for (const [platform, expected] of Object.entries(files))
				assert.equal(resolvePackagedE2eBinaryPath(directory, platform), expected);
			assert.equal(
				resolvePackagedE2eAppImagePath(directory, "0.6.3"),
				join(directory, "release/FlowsToken-0.6.3.AppImage"),
			);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}));

test("the actual PR smoke shell propagates failed WDIO exits on all three platforms", () =>
	fixture((directory) => {
		const bun = join(directory, "bun");
		const xvfb = join(directory, "xvfb-run");
		writeFileSync(
			bun,
			'#!/bin/sh\n[ "$2" != "test:e2e:packaged" ] || exit 0\n[ "$1" = "run" ] && [ "$2" = "test:e2e" ] || exit 97\n[ "$VETTA_PRODUCT_NAME" = "FlowsToken" ] && [ "$VETTA_EXECUTABLE_NAME" = "FlowsToken" ] && [ "$VETTA_APP_ID" = "com.flowstoken.desktop" ] || exit 98\n[ "$VETTA_E2E_PACKAGED" = "1" ] && [ "$VETTA_E2E_UPDATE_FEED" = "1" ] && [ "$VETTA_BUILD_ENV" = "test" ] && [ "$VETTA_SPEECH_INPUT_ENABLED" = "false" ] || exit 99\nexit 23\n',
		);
		writeFileSync(xvfb, '#!/bin/sh\nprintf "xvfb\\n" > "$XVFB_MARKER"\nshift\nexec "$@"\n');
		chmodSync(bun, 0o755);
		chmodSync(xvfb, 0o755);
		assert.deepEqual(smoke.strategy.matrix.include.map(({ platform }) => platform).sort(), [
			"Linux",
			"Windows",
			"macOS",
		]);
		for (const { platform } of smoke.strategy.matrix.include) {
			const marker = join(directory, `xvfb-${platform}`);
			const result = spawnSync(
				"bash",
				["-e", "-o", "pipefail", "-c", e2e.run.replaceAll("$" + "{{ matrix.platform }}", platform)],
				{
					cwd: directory,
					encoding: "utf8",
					env: {
						...process.env,
						...smoke.env,
						...e2e.env,
						PATH: `${directory}:${process.env.PATH}`,
						XVFB_MARKER: marker,
					},
				},
			);
			assert.equal(result.status, 23, `${platform}: ${result.stderr}`);
			if (platform === "Linux") assert.equal(readFileSync(marker, "utf8"), "xvfb\n");
			else assert.throws(() => readFileSync(marker));
		}
	}));
