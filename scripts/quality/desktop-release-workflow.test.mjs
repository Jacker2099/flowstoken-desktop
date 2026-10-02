import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(join(import.meta.dirname, "../../.github/workflows/desktop-release.yml"), "utf8");
const packagedWorkflow = readFileSync(
	join(import.meta.dirname, "../../.github/workflows/desktop-packaged.yml"),
	"utf8",
);
const upgradeWorkflow = readFileSync(
	join(import.meta.dirname, "../../.github/workflows/desktop-upgrade-e2e.yml"),
	"utf8",
);

const require = createRequire(join(import.meta.dirname, "../../apps/desktop/package.json"));
const { parse } = require("yaml");
const jobs = parse(workflow).jobs;
const packagedJobs = parse(packagedWorkflow).jobs;
function actionSteps(name) {
	return parse(readFileSync(join(import.meta.dirname, `../../.github/actions/${name}/action.yml`), "utf8")).runs.steps;
}

describe("Native SSH test tool prerequisites", () => {
	const sourceRunner = /test-(?:flowstoken-related|release-source|pr-source)\.mjs/;
	const workflowDirectory = join(import.meta.dirname, "../../.github/workflows");
	const callerWorkflows = readdirSync(workflowDirectory).filter((name) => {
		if (!/\.ya?ml$/.test(name)) return false;
		const config = parse(readFileSync(join(workflowDirectory, name), "utf8"));
		return Object.values(config.jobs).some((job) => job.steps?.some((step) => sourceRunner.test(step.run ?? "")));
	});
	it.each(callerWorkflows)("prepares tools before every actual source-test caller in %s", (name) => {
		const config = parse(readFileSync(join(workflowDirectory, name), "utf8"));
		let callers = 0;
		for (const job of Object.values(config.jobs)) {
			const steps = job.steps ?? [];
			const indices = steps.flatMap((step, index) => (sourceRunner.test(step.run ?? "") ? [index] : []));
			if (!indices.length) continue;
			callers += indices.length;
			const setup = steps.findIndex((step) => step.uses === "./.github/actions/setup-native-ssh-test-tools");
			expect(setup).toBeGreaterThanOrEqual(0);
			for (const index of indices) expect(setup).toBeLessThan(index);
			const install = steps.findIndex((step) => step.uses === "./.github/actions/install-bun-dependencies");
			if (install >= 0) expect(setup).toBeLessThan(install);
			const originalCheckout = steps.findIndex((step) => step.with?.ref?.includes("source"));
			if (originalCheckout >= 0) expect(setup).toBeLessThan(originalCheckout);
			if (name === "flowstoken-upstream-sync.yml") expect(steps[setup].if).toBe(steps[indices[0]].if);
		}
		expect(callers).toBeGreaterThan(0);
	});

	it("declares supported Node before every dependency or release script consumer", () => {
		for (const name of callerWorkflows) {
			for (const job of Object.values(parse(readFileSync(join(workflowDirectory, name), "utf8")).jobs)) {
				const steps = job.steps ?? [];
				const consumer = steps.findIndex(
					(step) => /\bnode\s/.test(step.run ?? "") || step.uses === "./.github/actions/install-bun-dependencies",
				);
				if (consumer < 0) continue;
				const setup = steps.findIndex(
					(step) =>
						step.uses === "actions/setup-node@v4" ||
						step.uses === "./.github/actions/setup-native-ssh-test-tools",
				);
				expect(setup).toBeGreaterThanOrEqual(0);
				const node =
					steps[setup].uses === "actions/setup-node@v4"
						? steps[setup]
						: actionSteps("setup-native-ssh-test-tools").find((step) => step.uses === "actions/setup-node@v4");
				expect(Number(node.with["node-version"])).toBeGreaterThanOrEqual(20);
				expect(setup).toBeLessThan(consumer);
			}
		}
	});

	it.each(["go", "rg", "fd"])("a genuinely absent %s fails before starting a native test", (missing) => {
		const directory = mkdtempSync(join(tmpdir(), "missing-ssh-tool-"));
		try {
			for (const tool of ["go", "rg", "fdfind"]) {
				if (tool === missing || (missing === "fd" && tool === "fdfind")) continue;
				writeFileSync(join(directory, tool), "#!/bin/sh\nprintf 'tool version\\n'\n");
				chmodSync(join(directory, tool), 0o755);
			}
			const bash =
				process.platform === "win32"
					? execFileSync("where.exe", ["bash"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]
					: "/bin/bash";
			const run = actionSteps("setup-native-ssh-test-tools").find(
				(step) => step.name === "Verify native POSIX tools",
			).run;
			const result = spawnSync(bash, ["-e", "-c", run], {
				env: { ...process.env, PATH: directory },
				encoding: "utf8",
			});
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(missing === "fd" ? "fdfind" : missing);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(["go", "rg", "fd", null])("strict POSIX executable version preflight: %s", (broken) => {
		const directory = mkdtempSync(join(tmpdir(), "native-ssh-tools-"));
		try {
			const trace = join(directory, "trace");
			// Use Debian's actual alternative name; no fd alias is required by the native contract.
			for (const tool of ["go", "rg", "fd", "fdfind"]) {
				writeFileSync(
					join(directory, tool),
					`#!/bin/sh\nprintf '%s:%s\\n' '${tool}' "$*" >> "$TOOL_TRACE"\n${tool === "fd" || broken === tool || (broken === "fd" && tool === "fdfind") ? "exit 23" : "printf 'tool version\\n'"}\n`,
				);
				chmodSync(join(directory, tool), 0o755);
			}
			const run = actionSteps("setup-native-ssh-test-tools").find(
				(step) => step.name === "Verify native POSIX tools",
			).run;
			const result = spawnSync("bash", ["-e", "-c", run], {
				env: {
					...process.env,
					PATH: `${directory}${delimiter}${process.env.PATH}`,
					TOOL_TRACE: trace.replaceAll("\\", "/"),
				},
				encoding: "utf8",
			});
			if (broken) expect(result.status).not.toBe(0);
			else {
				expect(result.status).toBe(0);
				expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual([
					"go:version",
					"rg:--version",
					"fd:--version",
					"fdfind:--version",
				]);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("Desktop release workflow contracts", () => {
	it("saves successful dependency downloads before later build or verification failures", () => {
		const steps = actionSteps("install-bun-dependencies");
		const restore = steps.findIndex((step) => step.uses === "actions/cache/restore@v4");
		const install = steps.findIndex((step) => step.run?.includes("install-ci-dependencies.mjs"));
		const save = steps.findIndex((step) => step.uses === "actions/cache/save@v4");
		expect(restore).toBeLessThan(install);
		expect(install).toBeLessThan(save);
		expect(steps[save].if).toBe("steps.bun-cache.outputs.cache-hit != 'true'");
		expect(steps[restore].with.path).toBe("~/.bun/install/cache");
		expect(steps[restore].with.key).toContain("runner.arch");
	});

	it("isolates model inputs and saves resources before compilation without caching application outputs", () => {
		const steps = actionSteps("prepare-desktop-resources");
		const restore = steps.find((step) => step.uses === "actions/cache/restore@v4");
		expect(restore.with["restore-keys"]).toBeUndefined();
		for (const input of [
			"runtimes/manifest.json",
			"speech-input/model-manifest.json",
			"fetch-ocr-models.js",
			"runner.arch",
		]) {
			expect(restore.with.key).toContain(input);
		}
		const save = steps.findIndex((step) => step.uses === "actions/cache/save@v4");
		expect(steps.findIndex((step) => step.name === "Download release resources")).toBeLessThan(save);
		expect(steps[save].with.path).toBe(restore.with.path);
		expect(restore.with.path).not.toMatch(/node_modules|build-stage|\.turbo|release\//);
		expect(
			jobs.build.steps.findIndex((step) => step.uses === "./.github/actions/prepare-desktop-resources"),
		).toBeLessThan(jobs.build.steps.findIndex((step) => step.name === "Build updater artifacts"));
	});

	it("retries verification using the same run's completed build without packaging again", () => {
		expect(jobs.build.strategy["fail-fast"]).toBe(false);
		expect(jobs.verify?.needs).toEqual(["prepare", "build"]);
		expect(jobs.verify?.strategy.matrix).toEqual(jobs.build.strategy.matrix);
		const buildSteps = jobs.build.steps;
		const verifySteps = jobs.verify?.steps ?? [];
		expect(buildSteps.some((step) => step.name === "Run packaged app and updater E2E")).toBe(false);
		const checkpoint = buildSteps.find((step) => step.name === "Upload build checkpoint");
		expect(checkpoint?.with.name).toBe("release-build-$" + "{{ matrix.platform }}");
		expect(checkpoint?.with["retention-days"]).toBe(30);
		expect(checkpoint?.with.overwrite).toBe(true);
		const downloads = verifySteps.filter(
			(step) => step.uses === "actions/download-artifact@v4" && step.with?.name === checkpoint?.with.name,
		);
		expect(downloads).toHaveLength(1);
		const download = downloads[0];
		expect(download?.with.name).toBe(checkpoint?.with.name);
		expect(download?.with["run-id"]).toBeUndefined();
		expect(verifySteps.some((step) => step.run?.includes("matrix.command"))).toBe(false);
		expect(verifySteps.findIndex((step) => step.name === "Restore build checkpoint")).toBeLessThan(
			verifySteps.findIndex((step) => step.name === "Verify platform updater artifacts"),
		);
		for (const target of ["publish-r2", "publish-github"]) {
			expect(jobs[target].needs).toContain("verify");
			expect(jobs[target].steps.find((step) => step.uses === "actions/download-artifact@v4").with.pattern).toBe(
				"desktop-*",
			);
		}
	});

	it("restores a failed verification attempt with original bytes, executable modes, symlinks and candidate version", () => {
		const root = mkdtempSync(join(tmpdir(), "vetta-release-checkpoint-"));
		try {
			const desktop = join(root, "apps/desktop");
			const release = join(desktop, "release");
			const runnerTemp = join(root, "runner");
			mkdirSync(release, { recursive: true });
			mkdirSync(runnerTemp);
			writeFileSync(join(desktop, "package.json"), JSON.stringify({ version: "0.5.58" }));
			writeFileSync(join(release, "Vetta"), "signed executable fixture");
			chmodSync(join(release, "Vetta"), 0o755);
			if (process.platform !== "win32") symlinkSync("Vetta", join(release, "bundle-link"));
			writeFileSync(join(release, "latest.yml"), "version: 0.5.59\n");
			writeFileSync(join(release, "installer.exe.files.json"), "verification manifest");
			const envFile = join(root, "github-env");
			const env = {
				...process.env,
				RUNNER_TEMP: runnerTemp,
				GITHUB_WORKSPACE: root,
				GITHUB_ENV: envFile,
				VETTA_REQUIRE_MAC_SIGNATURE: "1",
				BUILD_VERSION: "0.5.59",
			};
			execFileSync(
				"bash",
				["-e", "-c", jobs.build.steps.find((step) => step.name === "Archive build checkpoint").run],
				{ cwd: root, env },
			);
			mkdirSync(join(runnerTemp, "release-checkpoint"));
			writeFileSync(
				join(runnerTemp, "release-checkpoint/release-build.tar"),
				readFileSync(join(runnerTemp, "release-build.tar")),
			);
			// Verification can mutate the unpacked executable; retries must start from the saved build.
			writeFileSync(join(release, "Vetta"), "mutated during failed test");
			const restore = jobs.verify.steps.find((step) => step.name === "Restore build checkpoint").run;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				execFileSync("bash", ["-e", "-c", restore], { cwd: root, env });
				expect(readFileSync(join(release, "Vetta"), "utf8")).toBe("signed executable fixture");
				expect(readFileSync(join(release, "installer.exe.files.json"), "utf8")).toBe("verification manifest");
				expect(JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).version).toBe("0.5.59");
				if (process.platform !== "win32") {
					expect(statSync(join(release, "Vetta")).mode & 0o777).toBe(0o755);
					expect(readlinkSync(join(release, "bundle-link"))).toBe("Vetta");
				}
			}
			expect(readFileSync(envFile, "utf8")).toContain("VETTA_REQUIRE_MAC_SIGNATURE=1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prewarms tag-readable downloads on the default branch without building or publishing", () => {
		const warm = parse(readFileSync(join(import.meta.dirname, "../../.github/workflows/desktop-cache.yml"), "utf8"));
		expect(warm.on.schedule).toHaveLength(1);
		expect(warm.jobs.warm.if).toContain("github.event.repository.default_branch");
		expect([...warm.jobs.warm.strategy.matrix.runner].sort()).toEqual(
			jobs.build.strategy.matrix.include.map((entry) => entry.runner).sort(),
		);
		expect(warm.jobs.warm.steps.some((step) => /dist:|publish:/.test(step.run ?? ""))).toBe(false);
	});

	it("runs quality and packaging tests before the platform matrix", () => {
		expect(workflow).toContain("  quality:");
		expect(workflow).toContain("run: bun run check");
		expect(workflow).toContain("run: bun run test:quality");
		expect(workflow).toContain("run: bun run verify:desktop:contracts");
		expect(workflow).toContain("run: bun run test:desktop:packaging");
		expect(jobs.build.needs).toEqual(["prepare", "quality", "source-quality"]);
	});

	it("builds and verifies the pinned Windows sandbox before normal packaging", () => {
		const sandboxSteps = actionSteps("prepare-windows-sandbox");
		const checkout = sandboxSteps.find((step) => step.name === "Check out pinned Codex sandbox source");
		expect(checkout.with.repository).toBe("openvetta/codex");
		expect(checkout.with.ref).toMatch(/^[0-9a-f]{40}$/);
		expect(sandboxSteps.some((step) => step.run?.includes("cargo build --locked"))).toBe(true);
		expect(sandboxSteps.some((step) => step.run?.includes("--capabilities --json"))).toBe(true);
		for (const buildSteps of [jobs.build.steps, packagedJobs.smoke.steps]) {
			const sandbox = buildSteps.findIndex((step) => step.uses === "./.github/actions/prepare-windows-sandbox");
			expect(sandbox).toBeGreaterThanOrEqual(0);
			expect(buildSteps[sandbox].if).toContain("runner.os == 'Windows'");
			expect(sandbox).toBeLessThan(buildSteps.findIndex((step) => step.name === "Set up Bun"));
		}
		expect(jobs.build.steps.find((step) => step.name === "Prepare Windows sandbox").if).toContain(
			"needs.prepare.outputs.recovery != 'true'",
		);
	});

	it("verifies the public update feed after either publish target", () => {
		expect(workflow.match(/node scripts\/verify-update-feed\.mjs/g)).toHaveLength(2);
		for (const target of ["r2", "github"]) {
			expect(jobs[`publish-${target}`].needs).toEqual(["prepare", "quality", "source-quality", "build", "verify"]);
			const feed = jobs[`verify-feed-${target}`];
			expect(feed.needs).toEqual(["prepare", `publish-${target}`]);
			expect(feed.steps.some((step) => step.run?.includes("verify-update-feed.mjs"))).toBe(true);
			expect(feed.steps.some((step) => step.uses?.includes("download-artifact"))).toBe(false);
			expect(feed.steps.some((step) => /publish:|gh release|matrix.command/.test(step.run ?? ""))).toBe(false);
			expect(JSON.stringify(feed)).not.toContain("secrets.");
		}
	});

	it("runs packaged boot and updater E2E on every release platform", () => {
		expect(workflow).toContain("Run packaged app and updater E2E");
		expect(workflow).toContain('VETTA_E2E_UPDATE_FEED: "1"');
		expect(workflow).toContain("xvfb-run --auto-servernum bun run test:e2e");
		const initialVerify = workflow.indexOf("- name: Verify platform updater artifacts");
		const packagedE2e = workflow.indexOf("- name: Run packaged app and updater E2E");
		const finalVerify = workflow.indexOf("- name: Re-verify platform updater artifacts after packaged E2E");
		const upload = workflow.indexOf("- name: Upload updater artifacts");
		expect(initialVerify).toBeLessThan(packagedE2e);
		expect(packagedE2e).toBeLessThan(finalVerify);
		expect(finalVerify).toBeLessThan(upload);
	});

	it("keeps the pull-request packaged E2E matrix cross-platform", () => {
		expect(packagedWorkflow).toContain("runner: windows-latest");
		expect(packagedWorkflow).toContain("runner: macos-latest");
		expect(packagedWorkflow).toContain("runner: ubuntu-latest");
		expect(packagedWorkflow).toMatch(/bun run test:e2e(?:\s|$)/);
		expect(packagedWorkflow).not.toContain("bun run test:e2e:packaged");
		expect(packagedWorkflow).toContain("xvfb-run --auto-servernum");
	});

	it("installs Linux bubblewrap build dependencies in packaged and release builds", () => {
		for (const workflowSource of [packagedWorkflow, workflow]) {
			expect(workflowSource).toContain("Install Linux packaging dependencies");
			expect(workflowSource).toContain("if: runner.os == 'Linux'");
			expect(workflowSource).toContain("build-essential libcap-dev meson ninja-build pkg-config xz-utils");
		}
	});

	it("builds, verifies, installs, and uploads all Linux release formats", () => {
		expect(workflow).toContain("command: dist:linux");
		expect(workflow).toContain("verify: verify:updates:linux:release");
		expect(workflow).toContain("pkg-config xz-utils rpm");
		expect(workflow).toContain("Verify native Linux package installation");
		expect(workflow).toContain("ubuntu:24.04");
		expect(workflow).toContain("fedora:latest");
		expect(workflow).toContain("dnf install --assumeyes --nogpgcheck");
		expect(workflow).toContain(`test "$(cat "/opt/\${VETTA_EXECUTABLE_NAME}/resources/package-type")" = "deb"`);
		expect(workflow).toContain(`test "$(cat "/opt/\${VETTA_EXECUTABLE_NAME}/resources/package-type")" = "rpm"`);
		expect(workflow).toContain("apps/desktop/release/*.AppImage");
		expect(workflow).toContain("apps/desktop/release/*.deb");
		expect(workflow).toContain("apps/desktop/release/*.rpm");
	});

	it("keeps pull-request Linux packaging on the AppImage smoke target", () => {
		expect(packagedWorkflow).toContain("command: dist:linux:test");
		const desktopPackage = JSON.parse(
			readFileSync(join(import.meta.dirname, "../../apps/desktop/package.json"), "utf8"),
		);
		expect(desktopPackage.scripts["dist:linux:test"]).toContain("dist:linux:appimage");
	});

	it("builds, verifies, and uploads all Windows release formats", () => {
		expect(workflow).toContain("command: dist:win");
		expect(workflow).toContain("verify: verify:updates:windows");
		expect(workflow).toContain("Verify supplemental Windows packages");
		expect(workflow).toContain("run: bun run verify:packages:windows");
		expect(workflow).toContain("apps/desktop/release/*.exe");
		expect(workflow).toContain("apps/desktop/release/*.msi");
		expect(workflow).toContain("apps/desktop/release/*.zip");

		const desktopPackage = JSON.parse(
			readFileSync(join(import.meta.dirname, "../../apps/desktop/package.json"), "utf8"),
		);
		expect(desktopPackage.scripts["dist:win"]).toBe("bun run package:win");
		expect(desktopPackage.scripts["package:win"]).toMatch(/--platform win$/);
	});

	it("keeps pull-request Windows packaging on the unpacked smoke target", () => {
		expect(packagedWorkflow).toContain("build-command: pack:win:test");
		const desktopPackage = JSON.parse(
			readFileSync(join(import.meta.dirname, "../../apps/desktop/package.json"), "utf8"),
		);
		expect(desktopPackage.scripts["pack:win:test"]).toContain("pack:win");
	});

	it("installs the Electron audio runtime required by Ubuntu 24.04", () => {
		const packagedSmokeJob = packagedWorkflow.split("\n  smoke:\n")[1];
		const releaseBuildJob = workflow.split("\n  build:\n")[1]?.split("\n  publish-github:\n")[0];
		for (const jobSource of [packagedSmokeJob, releaseBuildJob]) {
			expect(jobSource).toBeDefined();
			expect(jobSource).toContain("Install Linux Electron runtime dependencies");
			expect(jobSource).toContain("libasound2t64");
		}
	});

	it("installs the IM gateway Go toolchain from its module declaration", () => {
		const packagedSmokeJob = packagedWorkflow.split("\n  smoke:\n")[1];
		const releaseBuildJob = workflow.split("\n  build:\n")[1]?.split("\n  publish-github:\n")[0];
		for (const jobSource of [packagedSmokeJob, releaseBuildJob]) {
			expect(jobSource).toBeDefined();
			expect(jobSource).toContain("Set up Go for IM gateway");
			expect(jobSource).toContain("uses: actions/setup-go@v5");
			expect(jobSource).toContain("go-version-file: apps/im-gateway/go.mod");
			expect(jobSource).toContain("cache-dependency-path: apps/im-gateway/go.sum");
		}
	});

	it("uses the same publish jobs for tagged stable and dispatched test/stable releases", () => {
		expect(workflow).toContain("build_version:");
		expect(workflow).toContain("should-publish: $" + "{{ steps.config.outputs.should_publish }}");
		expect(workflow).toContain("needs.prepare.outputs.should-publish == 'true'");
		expect(workflow).toContain("'desktop-test'");
		expect(workflow).toContain("environment: $" + "{{");
		expect(workflow).toContain("'desktop-production' }}");
		expect(workflow).toContain("OUTPUT_BUILD_VERSION");
		expect(workflow).toContain("REQUIRE_RELEASE_SIGNATURE");
		expect(workflow).toContain("needs.prepare.outputs.should-publish == 'true'");
		expect(workflow).toContain('--target "' + "$" + '{GITHUB_SHA}"');
	});

	// im-gateway 的 sidecar 由 prepare-pack.js 交叉编译进发布包，但它的 Go 测试
	// 既不在 `bun run check` 里，im-gateway.yml 也不 gate 本流水线。少了这道门禁，
	// 测试失败的 sidecar 会被静默打包发布。
	it("gates the release on the IM gateway Go tests", () => {
		const qualityJob = workflow.slice(workflow.indexOf("\n  quality:"), workflow.indexOf("\n  build:"));
		expect(qualityJob).toContain("go test ./...");
		expect(qualityJob).toContain("working-directory: apps/im-gateway");
		expect(qualityJob).toContain("go-version-file: apps/im-gateway/go.mod");
	});

	it("builds each macOS architecture on a matching hosted runner", () => {
		expect(workflow).toContain("runs-on: $" + "{{ matrix.runner }}");
		expect(workflow).toContain("runner: macos-15\n");
		expect(workflow).toContain("runner: macos-15-intel\n");
		expect(workflow).not.toContain("vetta-mac");
	});

	it("allows enough wall clock for signing and notarizing both macOS architectures", () => {
		const buildJob = workflow.slice(workflow.indexOf("\n  build:"), workflow.indexOf("\n  publish-r2:"));
		const timeout = Number(buildJob.match(/timeout-minutes: (\d+)/)?.[1]);
		expect(timeout).toBeGreaterThanOrEqual(120);
	});

	// R2 是更新源，GitHub Release 是对外的下载入口和版本说明归档。早先两个发布 job
	// 按 release_target 互斥，商业版发版在 GitHub 上什么都看不到。
	it("publishes a GitHub Release alongside R2 for every non-test channel", () => {
		expect(workflow).toContain("  publish-github:");
		expect(workflow).toContain("needs.prepare.outputs.channel != 'test'");
		expect(workflow).not.toContain("needs.prepare.outputs.release_target != 'r2'");
	});

	it("uses the versioned release note as the GitHub Release body", () => {
		expect(workflow).toContain("node scripts/release/release-notes.mjs --check");
		expect(workflow).toContain('--notes-file "' + "$" + '{NOTES_FILE}"');
		expect(workflow).not.toContain("--generate-notes");
		// 正文缺失要在质量阶段就失败，而不是等平台矩阵签名公证跑完。
		const qualityJob = workflow.slice(workflow.indexOf("\n  quality:"), workflow.indexOf("\n  build:"));
		expect(qualityJob).toContain("node scripts/release/release-notes.mjs --check");
	});

	it("provides an isolated test-channel workflow for real install and restart upgrades", () => {
		expect(upgradeWorkflow).toContain("baseline_version:");
		expect(upgradeWorkflow).toContain("candidate_version:");
		expect(upgradeWorkflow).toContain("environment: desktop-test");
		expect(upgradeWorkflow).toContain("bun run test:e2e:upgrade");
		expect(upgradeWorkflow).toContain("xvfb-run --auto-servernum");
		expect(upgradeWorkflow).toContain("upgrade-e2e-diagnostics");
	});
});
