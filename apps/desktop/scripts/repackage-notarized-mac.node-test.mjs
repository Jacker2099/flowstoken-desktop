import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readMacContainerSettings, repackageNotarizedMac } from "./repackage-notarized-mac.mjs";

const sourceRoot = process.env.FLOWSTOKEN_TEST_SOURCE_ROOT || resolve(import.meta.dirname, "../../..");
const sourceRequire = createRequire(join(sourceRoot, "apps/desktop/package.json"));
const rootRequire = createRequire(join(sourceRoot, "package.json"));
const ts = rootRequire("typescript");
const prepare = await readFile(join(sourceRoot, "apps/desktop/scripts/prepare-pack.js"), "utf8");
const sha = "a".repeat(40);
const cdhash = "b".repeat(40);
const brand = JSON.parse(await readFile(join(sourceRoot, "branding/flowstoken/product.json"), "utf8"));

async function fixture(options = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "flowstoken-repackage-test-")));
	const source = join(root, "source");
	const packageRoot = join(source, "apps/desktop");
	const app = join(root, "restored/FlowsToken.app");
	const output = join(root, "release");
	for (const dir of [
		join(source, "branding/flowstoken"),
		join(packageRoot, "scripts"),
		join(packageRoot, "build"),
		join(app, "Contents/Resources"),
	])
		await mkdir(dir, { recursive: true });
	await writeFile(join(source, "package.json"), "{}");
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: "0.6.3" }));
	await writeFile(join(source, "branding/flowstoken/product.json"), JSON.stringify(brand));
	await writeFile(join(packageRoot, "scripts/prepare-pack.js"), prepare);
	await writeFile(
		join(packageRoot, "scripts/resolve-release-info.mjs"),
		await readFile(join(sourceRoot, "apps/desktop/scripts/resolve-release-info.mjs")),
	);
	await writeFile(join(packageRoot, "CHANGELOG.md"), "## [0.6.3]\n\nRecovered release notes\n");
	await writeFile(join(packageRoot, "build/icon.icns"), "source icon");
	await symlink(join(sourceRoot, "node_modules"), join(source, "node_modules"), "dir");
	await symlink(join(sourceRoot, "apps/desktop/node_modules"), join(packageRoot, "node_modules"), "dir");
	await writeFile(
		join(app, "Contents/Resources/app-update.yml"),
		`provider: generic\nurl: ${options.updateUrl || brand.release.updateFeed}\nuseMultipleRangeRequest: true\n`,
	);
	const calls = [];
	let detailsReads = 0;
	let builderConfig;
	let stage;
	const run = async (command, args, runOptions = {}) => {
		calls.push({ command, args, options: runOptions });
		if (command === "git")
			return {
				stdout: args.includes("rev-parse")
					? options.checkoutSha || sha
					: options.dirty
						? " M packaging-input\n"
						: "",
				stderr: "",
			};
		if (command === "/usr/libexec/PlistBuddy") {
			const key = args[1].slice("Print :".length);
			const values = {
				CFBundleIdentifier: options.appId || brand.appId,
				CFBundleShortVersionString: options.version || "0.6.3",
				CFBundleVersion: options.version || "0.6.3",
				CFBundleExecutable: brand.executableName,
			};
			return {
				stdout: args[2].includes("Electron Framework.framework")
					? sourceRequire("electron/package.json").version
					: values[key],
				stderr: "",
			};
		}
		if (command === "/usr/bin/lipo") return { stdout: options.machineArch || "arm64", stderr: "" };
		if (command === "codesign" && args.includes("-d"))
			return {
				stdout: "",
				stderr: `Authority=Developer ID Application: Test\nTeamIdentifier=TEAM123\nCDHash=${(options.changedHash && detailsReads++) || (options.copyHashMismatch && args.at(-1).startsWith(output)) ? "c".repeat(40) : cdhash}\n`,
			};
		if (["codesign", "spctl", "xcrun"].includes(command)) {
			if (options.failGate === command) throw new Error(`${command} rejected fixture`);
			return { stdout: "", stderr: "" };
		}
		if (command === "/usr/bin/ditto") {
			await cp(args[0], args[1], { recursive: true, dereference: false });
			return { stdout: "", stderr: "" };
		}
		assert.equal(command, process.execPath);
		if (args[0].endsWith("generate-dmg-background.js")) {
			assert.equal(args[1], "--two-icons");
			await writeFile(join(packageRoot, "build/background.png"), "generated from source");
		} else if (args.includes("--prepackaged")) {
			stage = args.find((arg) => arg.startsWith("--project=")).slice("--project=".length);
			builderConfig = JSON.parse(
				await readFile(args.find((arg) => arg.startsWith("--config=")).slice("--config=".length), "utf8"),
			);
			if (options.builderFailure) throw new Error("container command failed");
			const suffix = args.includes("--x64") ? "" : "-arm64";
			for (const name of [`FlowsToken-0.6.3${suffix}.dmg`, `FlowsToken-0.6.3${suffix}-mac.zip`]) {
				await writeFile(join(output, name), "container fixture");
				if (
					!(name.endsWith(".dmg") && options.omitDmgBlockmap) &&
					!(name.endsWith(".zip") && options.omitZipBlockmap)
				)
					await writeFile(join(output, `${name}.blockmap`), "blockmap fixture");
			}
			await writeFile(join(output, "latest-mac.yml"), "version: 0.6.3\n");
		} else {
			assert.equal(args[0], "--input-type=module");
			assert.match(args[2], /requireSignature:true/);
			assert.equal(args[4], output);
			if (options.outputFailure) throw new Error("ZIP gate failed");
		}
		return { stdout: "", stderr: "" };
	};
	return {
		root,
		source,
		packageRoot,
		app,
		output,
		calls,
		run,
		getConfig: () => builderConfig,
		getStage: () => stage,
		params: { app, sourceRoot: source, sourceSha: sha, output, arch: "arm64" },
	};
}

async function withFixture(options, run) {
	const f = await fixture(options);
	try {
		await run(f);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
}

test("reads the original signed DMG layout without evaluating prepare-pack or carrying signing hooks", () => {
	const config = readMacContainerSettings(`${prepare}\nthrow new Error('must not execute');`, ts);
	assert.equal(config.packageName, "vetta");
	assert.deepEqual(config.mac.target, ["dmg", "zip"]);
	assert.deepEqual(config.dmg.contents, [
		{ x: 180, y: 200, type: "file" },
		{ x: 480, y: 200, type: "link", path: "/Applications" },
	]);
	assert.equal(config.dmg.window.width, 660);
	for (const key of ["identity", "notarize", "afterPack", "afterSign", "sign"])
		assert.equal(config.mac[key], undefined);
	assert.throws(
		() =>
			readMacContainerSettings(
				prepare.replace('background: "build/background.png"', "background: unknownBackground()"),
				ts,
			),
		/dynamic container expression/,
	);
	assert.throws(
		() => readMacContainerSettings(prepare.replace("mac: {", "...unknownConfig,\nmac: {"), ts),
		/unknown builder config spread/,
	);
});

test("electron-builder 26.15.2 prepackaged non-MAS targets bypass doPack and the app signing path", async () => {
	const builderRequire = createRequire(sourceRequire.resolve("electron-builder/package.json"));
	assert.equal(builderRequire("app-builder-lib/package.json").version, "26.15.2");
	builderRequire("app-builder-lib");
	const { MacPackager } = builderRequire("app-builder-lib/out/macPackager.js");
	const built = [];
	const packager = {
		packagerOptions: { prepackaged: "/restored/FlowsToken.app" },
		packMasTargets: async (_out, _arch, targets) => assert.deepEqual(targets, []),
		packMacTargets: MacPackager.prototype.packMacTargets,
		doPack: () => assert.fail("must not repack the signed app"),
		doSignAfterPack: () => assert.fail("must not sign the app"),
		packageInDistributableFormat: (...args) => built.push(args),
	};
	const targets = [{ name: "dmg" }, { name: "zip" }];
	const taskManager = {};
	await MacPackager.prototype.pack.call(packager, "/release", 3, targets, taskManager);
	assert.deepEqual(built, [["/restored/FlowsToken.app", 3, targets, taskManager]]);
});

test("packages only containers after all trust checks, then revalidates signatures and records the unchanged CDHash", async () =>
	withFixture({}, async (f) => {
		const proof = await repackageNotarizedMac(f.params, {
			run: f.run,
			platform: "darwin",
			env: { CSC_LINK: "private", APPLE_API_KEY: "private", PATH: "/bin" },
		});
		assert.equal(proof.cdhash, cdhash);
		assert.equal(proof.sourceSha, sha);
		assert.equal(proof.version, "0.6.3");
		const builderIndex = f.calls.findIndex((call) => call.args.includes("--prepackaged"));
		assert.ok(
			f.calls
				.slice(0, builderIndex)
				.some((call) => call.command === "xcrun" && call.args[0] === "stapler" && call.args[1] === "validate"),
		);
		const builder = f.calls[builderIndex];
		assert.deepEqual(builder.args.slice(-7), [
			"--prepackaged",
			f.app,
			"--mac",
			"dmg",
			"zip",
			"--arm64",
			"--publish=never",
		]);
		assert.equal(builder.options.env.APPLE_API_KEY, undefined);
		assert.equal(builder.options.env.CSC_LINK, undefined);
		const config = f.getConfig();
		assert.equal(config.appId, brand.appId);
		assert.equal(config.productName, brand.productName);
		assert.equal(config.publish[0].url, brand.release.updateFeed);
		for (const key of ["afterSign", "afterPack", "beforePack"]) assert.equal(config[key], undefined);
		assert.equal(config.mac.notarize, undefined);
		assert.equal(config.mac.identity, undefined);
		assert.equal(
			f.calls.some((call) => call.args.some((arg) => ["submit", "--sign", "staple"].includes(arg))),
			false,
		);
		assert.equal(f.calls.filter((call) => call.command === "spctl").length, 3);
		assert.equal(proof.checkpointApp, "mac-arm64/FlowsToken.app");
		assert.equal((await stat(join(f.output, proof.checkpointApp))).isDirectory(), true);
		assert.equal(JSON.parse(await readFile(join(f.output, "recovery-repackage.json"), "utf8")).cdhash, cdhash);
		await assert.rejects(stat(f.getStage()), { code: "ENOENT" });
	}));

for (const [label, options] of [
	["wrong source", { checkoutSha: "d".repeat(40) }],
	["dirty source", { dirty: true }],
	["wrong URL", { updateUrl: "https://example.invalid/updates" }],
	["wrong version", { version: "0.6.2" }],
	["wrong app ID", { appId: "com.vetta.desktop" }],
	["wrong arch", { machineArch: "x86_64" }],
	["invalid code signature", { failGate: "codesign" }],
	["not accepted by Gatekeeper", { failGate: "spctl" }],
	["missing stapled ticket", { failGate: "xcrun" }],
])
	test(`refuses container packaging for ${label}`, async () =>
		withFixture(options, async (f) => {
			await assert.rejects(repackageNotarizedMac(f.params, { run: f.run, platform: "darwin" }));
			assert.equal(
				f.calls.some((call) => call.args.includes("--prepackaged")),
				false,
			);
		}));

for (const options of [{ changedHash: true }, { builderFailure: true }, { outputFailure: true }]) {
	test(`does not produce recovery proof after ${Object.keys(options)[0]}`, async () =>
		withFixture(options, async (f) => {
			await assert.rejects(repackageNotarizedMac(f.params, { run: f.run, platform: "darwin" }));
			await assert.rejects(stat(join(f.output, "recovery-repackage.json")), { code: "ENOENT" });
			assert.equal(f.calls.filter((call) => call.command === "spctl").length, options.outputFailure ? 3 : 2);
		}));
}

test("refuses overwriting existing output files", async () =>
	withFixture({}, async (f) => {
		await mkdir(f.output);
		await writeFile(join(f.output, "keep.txt"), "existing output");
		await assert.rejects(repackageNotarizedMac(f.params, { run: f.run, platform: "darwin" }), /non-empty output/);
		assert.deepEqual(await readdir(f.output), ["keep.txt"]);
	}));

test("recognizes but never carries the dedicated afterSign notarization hook", () => {
	const hook =
		'...(macSigning.enabled && macSigning.notarize ? { afterSign: join(projectRoot, "scripts", "notarize-mac-app.mjs") } : {}),';
	const withHook = prepare.replace("const builderConfig = {", `const builderConfig = {\n${hook}`);
	assert.deepEqual(readMacContainerSettings(withHook, ts), readMacContainerSettings(prepare, ts));
	assert.throws(
		() => readMacContainerSettings(withHook.replace('"notarize-mac-app.mjs"', '"other-hook.mjs"'), ts),
		/unknown afterSign hook/,
	);
});

test("allows a DMG without an optional blockmap while retaining the mandatory ZIP blockmap", async () =>
	withFixture({ omitDmgBlockmap: true }, async (f) => {
		await repackageNotarizedMac(f.params, { run: f.run, platform: "darwin" });
		assert.equal((await readdir(f.output)).filter((name) => name.endsWith(".blockmap")).length, 1);
		assert.equal((await readdir(f.output)).filter((name) => name.endsWith(".zip.blockmap")).length, 1);
	}));

test("preserves the x64 architecture and native mac checkpoint path", async () =>
	withFixture({ machineArch: "x86_64" }, async (f) => {
		const proof = await repackageNotarizedMac({ ...f.params, arch: "x64" }, { run: f.run, platform: "darwin" });
		assert.equal(proof.arch, "x64");
		assert.equal(proof.checkpointApp, "mac/FlowsToken.app");
		assert.ok(f.calls.some((call) => call.args.includes("--prepackaged") && call.args.includes("--x64")));
		assert.ok((await readdir(f.output)).includes("FlowsToken-0.6.3-mac.zip"));
	}));

test("rejects a changed checkpoint copy without certifying recovery", async () =>
	withFixture({ copyHashMismatch: true }, async (f) => {
		await assert.rejects(
			repackageNotarizedMac(f.params, { run: f.run, platform: "darwin" }),
			/checkpoint copy differs/,
		);
		await assert.rejects(stat(join(f.output, "recovery-repackage.json")), { code: "ENOENT" });
	}));

test("still refuses a ZIP missing its mandatory blockmap", async () =>
	withFixture({ omitZipBlockmap: true }, async (f) => {
		await assert.rejects(repackageNotarizedMac(f.params, { run: f.run, platform: "darwin" }));
		await assert.rejects(stat(join(f.output, "recovery-repackage.json")), { code: "ENOENT" });
	}));

test("rejects a symlink output pointing inside the signed app before packaging can mutate it", async () =>
	withFixture({}, async (f) => {
		const inside = join(f.app, "Contents/empty-output");
		await mkdir(inside);
		await symlink(inside, f.output, "dir");
		await assert.rejects(repackageNotarizedMac(f.params, { run: f.run, platform: "darwin" }), /symbolic link/);
		assert.equal(
			f.calls.some((call) => call.args.includes("--prepackaged")),
			false,
		);
		assert.deepEqual(await readdir(inside), []);
	}));

test("does not mistake an app child named '..output' for a separate directory", async () =>
	withFixture({}, async (f) => {
		await assert.rejects(
			repackageNotarizedMac({ ...f.params, output: join(f.app, "..output") }, { run: f.run, platform: "darwin" }),
			/separate directories/,
		);
		assert.equal(
			f.calls.some((call) => call.args.includes("--prepackaged")),
			false,
		);
		await assert.rejects(stat(join(f.app, "..output")), { code: "ENOENT" });
	}));
