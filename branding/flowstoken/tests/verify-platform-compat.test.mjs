import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolvePackagedE2eAppImagePath, resolvePackagedE2eBinaryPath } from "../../../apps/desktop/scripts/packaged-e2e-binary.mjs";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(join(root, "apps/desktop/package.json"));
const { parse } = require("yaml");
const workflow = parse(readFileSync(join(root, ".github/workflows/desktop-release.yml"), "utf8"));
const verify = workflow.jobs.verify;

function tempFixture(run) {
	const dir = mkdtempSync(join(tmpdir(), "flowstoken-verify-"));
	try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("checkpoint restore works from a spaced working directory without passing Windows drive paths to tar", () => tempFixture((dir) => {
	const workspace = join(dir, "workspace with spaces");
	const runner = join(dir, "runner temp");
	const checkpoint = join(runner, "release-checkpoint");
	const source = join(dir, "source");
	mkdirSync(join(workspace, "apps/desktop"), { recursive: true });
	mkdirSync(checkpoint, { recursive: true });
	mkdirSync(join(source, "release"), { recursive: true });
	writeFileSync(join(source, "release/require-mac-signature.txt"), "1\n");
	writeFileSync(join(source, "release/payload.txt"), "checkpoint bytes");
	writeFileSync(join(workspace, "apps/desktop/package.json"), JSON.stringify({ version: "0.6.2" }));
	execFileSync("tar", ["-cf", join(checkpoint, "release-build.tar"), "-C", source, "release"]);
	const restore = verify.steps.find((step) => step.name === "Restore build checkpoint");
	execFileSync("bash", ["-e", "-o", "pipefail", "-c", restore.run], {
		cwd: workspace,
		env: { ...process.env, RUNNER_TEMP: runner, GITHUB_WORKSPACE: "D:\\a\\flowstoken-desktop\\flowstoken-desktop",
			GITHUB_ENV: join(dir, "github-env"), BUILD_VERSION: "0.6.3" },
	});
	assert.equal(readFileSync(join(workspace, "apps/desktop/release/payload.txt"), "utf8"), "checkpoint bytes");
	assert.equal(JSON.parse(readFileSync(join(workspace, "apps/desktop/package.json"), "utf8")).version, "0.6.3");
	assert.match(readFileSync(join(dir, "github-env"), "utf8"), /^VETTA_REQUIRE_MAC_SIGNATURE=1$/m);
}));

test("fresh verification jobs use the packaged FlowsToken brand across all platform checks and E2E", () => tempFixture((dir) => {
	assert.equal(verify.env.VETTA_PRODUCT_NAME, "FlowsToken");
	assert.equal(verify.env.VETTA_EXECUTABLE_NAME, "FlowsToken");
	assert.equal(verify.env.VETTA_APP_ID, "com.flowstoken.desktop");
	const e2e = verify.steps.find((step) => step.name === "Run packaged app and updater E2E");
	assert.match(e2e.run, /bun run test:e2e(?:\s|$)/);
	assert.doesNotMatch(e2e.run, /test:e2e:packaged|\|\|/);
	assert.notEqual(e2e["continue-on-error"], true);
	assert.equal(e2e.env.VETTA_E2E_PACKAGED, "1");
	const previous = Object.fromEntries(Object.keys(verify.env).map((key) => [key, process.env[key]]));
	try {
		Object.assign(process.env, verify.env);
		const paths = {
			win32: join(dir, "release/win-unpacked/versions/0.6.3/FlowsToken.exe"),
			darwin: join(dir, "release/mac-arm64/FlowsToken.app/Contents/MacOS/FlowsToken"),
			linux: join(dir, "release/linux-unpacked/FlowsToken"),
		};
		for (const path of Object.values(paths)) { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, "fixture"); }
		writeFileSync(join(dir, "release/win-unpacked/current.json"), JSON.stringify({ version: "0.6.3" }));
		writeFileSync(join(dir, "release/FlowsToken-0.6.3.AppImage"), "fixture");
		for (const [platform, path] of Object.entries(paths)) assert.equal(resolvePackagedE2eBinaryPath(dir, platform), path);
		assert.equal(resolvePackagedE2eAppImagePath(dir, "0.6.3"), join(dir, "release/FlowsToken-0.6.3.AppImage"));
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
}));

test("both native Linux install probes accept only the branded executable, package marker and desktop entry", () => tempFixture((dir) => {
	const probe = verify.steps.find((step) => step.name === "Verify native Linux package installation");
	const commands = [...probe.run.matchAll(/bash -euo pipefail -c '([\s\S]*?)'/g)].map((match) => match[1]);
	assert.equal(commands.length, 2);
	assert.equal((probe.run.match(/--env VETTA_EXECUTABLE_NAME/g) ?? []).length, 2);
	const app = join(dir, "opt/FlowsToken/FlowsToken");
	mkdirSync(join(dir, "opt/FlowsToken/resources"), { recursive: true });
	mkdirSync(join(dir, "usr/share/applications"), { recursive: true });
	writeFileSync(app, "fixture"); chmodSync(app, 0o755);
	writeFileSync(join(dir, "usr/share/applications/FlowsToken.desktop"), "[Desktop Entry]\nExec=/opt/FlowsToken/FlowsToken %U\n");
	for (const [index, marker] of ["deb", "rpm"].entries()) {
		writeFileSync(join(dir, "opt/FlowsToken/resources/package-type"), marker);
		const command = commands[index]
			.replaceAll('test -x "/opt/', 'test -x "${TEST_ROOT}/opt/')
			.replaceAll('cat "/opt/', 'cat "${TEST_ROOT}/opt/')
			.replaceAll("find /usr/share/applications", 'find "${TEST_ROOT}/usr/share/applications"');
		const options = { env: { ...process.env, ...verify.env, TEST_ROOT: dir }, stdio: "pipe" };
		execFileSync("bash", ["-e", "-o", "pipefail", "-c", `apt-get() { :; }; dnf() { :; }; ${command}`], options);
		writeFileSync(join(dir, "opt/FlowsToken/resources/package-type"), "wrong");
		assert.throws(() => execFileSync("bash", ["-e", "-o", "pipefail", "-c", `apt-get() { :; }; dnf() { :; }; ${command}`], options));
	}
}));
