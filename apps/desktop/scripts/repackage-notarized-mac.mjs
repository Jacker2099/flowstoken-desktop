import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUILDER_VERSION = "26.15.2";
const SOURCE_FILES = [
	"apps/desktop/package.json",
	"branding/flowstoken/product.json",
	"bun.lock",
	"apps/desktop/scripts/prepare-pack.js",
	"apps/desktop/scripts/generate-dmg-background.js",
	"apps/desktop/scripts/verify-mac-update.mjs",
	"apps/desktop/scripts/resolve-release-info.mjs",
	"apps/desktop/CHANGELOG.md",
];

function assert(value, message) {
	if (!value) throw new Error(`[repackage-mac] ${message}`);
}

async function runCommand(command, args, options = {}) {
	const { inherit = false, ...execOptions } = options;
	if (!inherit) return execFileAsync(command, args, { encoding: "utf8", timeout: 120_000, ...execOptions });
	await new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { ...execOptions, stdio: "inherit" });
		child.once("error", reject);
		child.once("close", (code) =>
			code === 0 ? resolvePromise() : reject(new Error(`${basename(command)} exited ${code}`)),
		);
	});
	return { stdout: "", stderr: "" };
}

/** Only literals and the existing signed-DMG conditional are interpreted; no source code runs. */
export function readMacContainerSettings(sourceText, ts) {
	const source = ts.createSourceFile("prepare-pack.js", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	assert(source.parseDiagnostics.length === 0, "prepare-pack.js could not be parsed");
	const nameOf = (property) => {
		assert(
			property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)),
			"dynamic property name",
		);
		return property.name.text;
	};
	const property = (object, name, required = true) => {
		assert(ts.isObjectLiteralExpression(object), `${name} must belong to a literal object`);
		const matches = object.properties.filter((entry) => !ts.isSpreadAssignment(entry) && nameOf(entry) === name);
		assert(matches.length <= 1 && (!required || matches.length === 1), `missing or duplicated ${name}`);
		if (!matches.length) return undefined;
		assert(ts.isPropertyAssignment(matches[0]), `${name} must be a static property assignment`);
		return matches[0].initializer;
	};
	const variable = (name) => {
		const matches = source.statements
			.filter(ts.isVariableStatement)
			.flatMap((statement) => statement.declarationList.declarations)
			.filter((entry) => ts.isIdentifier(entry.name) && entry.name.text === name);
		assert(matches.length === 1 && matches[0].initializer, `missing or duplicated ${name}`);
		return matches[0].initializer;
	};
	const literal = (node) => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
		if (ts.isNumericLiteral(node)) return Number(node.text);
		if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
		if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
		if (node.kind === ts.SyntaxKind.NullKeyword) return null;
		if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
		if (ts.isConditionalExpression(node) && node.condition.getText(source) === "macSigning.enabled")
			return literal(node.whenTrue);
		if (ts.isObjectLiteralExpression(node)) {
			const value = {};
			for (const entry of node.properties) {
				assert(ts.isPropertyAssignment(entry), "dynamic container spread or shorthand is unsupported");
				const name = nameOf(entry);
				assert(
					!Object.hasOwn(value, name) && !["__proto__", "constructor", "prototype"].includes(name),
					"invalid container key",
				);
				value[name] = literal(entry.initializer);
			}
			return value;
		}
		throw new Error(`[repackage-mac] dynamic container expression is unsupported: ${node.getText(source)}`);
	};
	const config = variable("builderConfig");
	// Only known metadata spreads and the dedicated notarization hook are accepted.
	// The hook is intentionally not carried into a prepackaged container build.
	for (const entry of config.properties.filter(ts.isSpreadAssignment)) {
		let expression = entry.expression;
		if (ts.isParenthesizedExpression(expression)) expression = expression.expression;
		assert(ts.isConditionalExpression(expression), "unknown builder config spread");
		const condition = expression.condition.getText(source);
		const field =
			condition === "updatePublishConfig"
				? "publish"
				: condition === "releaseInfo"
					? "releaseInfo"
					: condition.replace(/\s+/g, "") === "macSigning.enabled&&macSigning.notarize"
						? "afterSign"
						: null;
		assert(
			field &&
				ts.isObjectLiteralExpression(expression.whenTrue) &&
				ts.isObjectLiteralExpression(expression.whenFalse),
			"unknown builder config spread",
		);
		assert(
			expression.whenTrue.properties.length === 1 &&
				nameOf(expression.whenTrue.properties[0]) === field &&
				expression.whenFalse.properties.length === 0,
			"builder config spread changes container settings",
		);
		if (field === "afterSign") {
			const value = property(expression.whenTrue, "afterSign");
			assert(
				ts.isCallExpression(value) &&
					ts.isIdentifier(value.expression) &&
					value.expression.text === "join" &&
					value.arguments.length === 3 &&
					ts.isIdentifier(value.arguments[0]) &&
					value.arguments[0].text === "projectRoot" &&
					ts.isStringLiteral(value.arguments[1]) &&
					value.arguments[1].text === "scripts" &&
					ts.isStringLiteral(value.arguments[2]) &&
					value.arguments[2].text === "notarize-mac-app.mjs",
				"unknown afterSign hook",
			);
		}
	}
	const macSource = property(config, "mac");
	const mac = {};
	for (const field of ["target", "category", "icon", "artifactName", "defaultArch", "bundleShortVersion"]) {
		const value = property(macSource, field, ["target", "category", "icon"].includes(field));
		if (value) mac[field] = literal(value);
	}
	for (const entry of macSource.properties.filter(ts.isSpreadAssignment)) {
		let expression = entry.expression;
		if (ts.isParenthesizedExpression(expression)) expression = expression.expression;
		assert(
			ts.isConditionalExpression(expression) && expression.condition.getText(source) === "macSigning.enabled",
			"unknown mac config spread",
		);
		const signingFields = new Set([
			"hardenedRuntime",
			"gatekeeperAssess",
			"entitlements",
			"entitlementsInherit",
			"notarize",
			"identity",
		]);
		for (const branch of [expression.whenTrue, expression.whenFalse]) {
			assert(
				ts.isObjectLiteralExpression(branch) && branch.properties.every((item) => signingFields.has(nameOf(item))),
				"mac signing spread changes container settings",
			);
		}
	}
	const dmg = literal(property(config, "dmg"));
	assert(
		JSON.stringify(mac.target) === JSON.stringify(["dmg", "zip"]),
		"recovery supports only the original DMG and ZIP targets",
	);
	assert(dmg.sign !== true && dmg.writeUpdateInfo !== false, "unsupported DMG signing or disabled update metadata");
	assert(
		dmg.contents?.length === 2 &&
			dmg.contents[0].type === "file" &&
			dmg.contents[0].path === undefined &&
			dmg.contents[1].type === "link" &&
			dmg.contents[1].path === "/Applications",
		"expected the original signed two-icon DMG layout",
	);
	assert(
		property(config, "extraDistFiles", false) === undefined,
		"extraDistFiles is unsupported for immutable-app recovery",
	);
	const options = {};
	for (const field of ["artifactName", "compression"]) {
		const value = property(config, field, false);
		if (value) options[field] = literal(value);
	}
	const zip = property(config, "zip", false);
	if (zip) options.zip = literal(zip);
	const appPackage = variable("appPkg");
	return {
		mac,
		dmg,
		options,
		packageName: literal(property(appPackage, "name")),
		description: literal(property(appPackage, "description")),
	};
}

function resourcePath(packageRoot, value) {
	assert(typeof value === "string" && !isAbsolute(value), "container resource must be relative to the source package");
	const result = resolve(packageRoot, value);
	assert(!relative(packageRoot, result).startsWith(".."), "container resource escapes the source package");
	return result;
}

function containerEnvironment(env, brand) {
	const result = {
		...env,
		VETTA_PRODUCT_NAME: brand.productName,
		VETTA_EXECUTABLE_NAME: brand.executableName,
		VETTA_APP_ID: brand.appId,
	};
	for (const key of Object.keys(result)) {
		if (/^(CSC_|APPLE_|VETTA_SKIP_NOTARIZE$)/.test(key)) delete result[key];
	}
	return result;
}

async function inspectApp(app, brand, version, arch, run) {
	const plist = join(app, "Contents/Info.plist");
	const readPlist = async (file, key) =>
		(await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, file])).stdout.trim();
	assert((await readPlist(plist, "CFBundleIdentifier")) === brand.appId, "app bundle ID differs from source branding");
	assert(
		(await readPlist(plist, "CFBundleShortVersionString")) === version &&
			(await readPlist(plist, "CFBundleVersion")) === version,
		"app version differs from source package",
	);
	assert(
		(await readPlist(plist, "CFBundleExecutable")) === brand.executableName,
		"app executable differs from source branding",
	);
	const architectures = (
		await run("/usr/bin/lipo", ["-archs", join(app, "Contents/MacOS", brand.executableName)])
	).stdout
		.trim()
		.split(/\s+/);
	assert(
		architectures.length === 1 && architectures[0] === (arch === "x64" ? "x86_64" : arch),
		"app architecture differs from requested architecture",
	);
	await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
	await run("spctl", ["-a", "-vvv", "-t", "exec", app]);
	await run("xcrun", ["stapler", "validate", app]);
	const details = await run("codesign", ["-d", "--verbose=4", app]);
	const text = `${details.stdout}\n${details.stderr}`;
	const cdhash = /^CDHash=([a-f\d]{40,64})$/im.exec(text)?.[1].toLowerCase();
	const teamId = /^TeamIdentifier=([A-Z\d]+)$/m.exec(text)?.[1];
	assert(
		cdhash && teamId && /^Authority=Developer ID Application:/m.test(text),
		"missing Developer ID signature details",
	);
	const electronVersion = await readPlist(
		join(app, "Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"),
		"CFBundleVersion",
	);
	return { cdhash, teamId, electronVersion };
}

export async function repackageNotarizedMac(
	{ app, sourceRoot, sourceSha, output, arch },
	{ run = runCommand, platform = process.platform, env = process.env } = {},
) {
	assert(platform === "darwin", "Mac container recovery requires macOS");
	assert(/^[a-f\d]{40}$/.test(sourceSha ?? ""), "a full source SHA is required");
	assert(["arm64", "x64"].includes(arch), "architecture must be arm64 or x64");
	assert(app && sourceRoot && output, "app, source-root and output are required");
	app = await realpath(app);
	sourceRoot = await realpath(sourceRoot);
	const requestedOutput = resolve(output);
	const outputEntry = await lstat(requestedOutput).catch((error) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	assert(!outputEntry?.isSymbolicLink(), "output must not be a symbolic link");
	output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
	assert(app.endsWith(".app") && (await stat(app)).isDirectory(), "expected a restored .app directory");
	assert(
		[relative(app, output), relative(output, app)].every((path) => path === ".." || path.startsWith(`..${sep}`)),
		"output and signed app must be separate directories",
	);
	assert(
		(await run("git", ["-C", sourceRoot, "rev-parse", "HEAD"])).stdout.trim() === sourceSha,
		"source checkout SHA mismatch",
	);
	assert(
		!(
			await run("git", ["-C", sourceRoot, "status", "--porcelain", "--untracked-files=no", "--", ...SOURCE_FILES])
		).stdout.trim(),
		"source packaging inputs are modified",
	);
	assert(
		(
			await readdir(output).catch((error) => {
				if (error.code === "ENOENT") return [];
				throw error;
			})
		).length === 0,
		"refusing to overwrite a non-empty output directory",
	);
	const packageRoot = join(sourceRoot, "apps/desktop");
	const brand = JSON.parse(await readFile(join(sourceRoot, "branding/flowstoken/product.json"), "utf8"));
	assert(
		brand.productName === "FlowsToken" &&
			brand.executableName === "FlowsToken" &&
			brand.appId === "com.flowstoken.desktop",
		"recovery requires the original FlowsToken brand",
	);
	assert(basename(app) === `${brand.productName}.app`, "restored app filename differs from source branding");
	const { version } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	assert(/^\d+\.\d+\.\d+$/.test(version), "invalid source package version");
	const sourceRequire = createRequire(join(packageRoot, "package.json"));
	const { parse } = sourceRequire("yaml");
	const ts = createRequire(join(sourceRoot, "package.json"))("typescript");
	const embeddedUpdate = parse(await readFile(join(app, "Contents/Resources/app-update.yml"), "utf8"));
	assert(
		embeddedUpdate?.provider === "generic" &&
			embeddedUpdate.url === brand.release?.updateFeed &&
			embeddedUpdate.url === "https://www.flowstoken.com/downloads/desktop" &&
			embeddedUpdate.useMultipleRangeRequest === true,
		"signed app update URL differs from source branding",
	);
	const builderPackagePath = sourceRequire.resolve("electron-builder/package.json");
	assert(
		JSON.parse(await readFile(builderPackagePath, "utf8")).version === BUILDER_VERSION,
		"electron-builder version changed; re-audit prepackaged behavior",
	);
	const builderRequire = createRequire(builderPackagePath);
	assert(
		builderRequire("app-builder-lib/package.json").version === BUILDER_VERSION,
		"app-builder-lib version changed",
	);
	const settings = readMacContainerSettings(await readFile(join(packageRoot, "scripts/prepare-pack.js"), "utf8"), ts);
	const before = await inspectApp(app, brand, version, arch, run);
	assert(
		sourceRequire("electron/package.json").version === before.electronVersion,
		"packaged Electron version differs from source dependencies",
	);
	const childEnv = containerEnvironment(env, brand);
	await run(process.execPath, [join(packageRoot, "scripts/generate-dmg-background.js"), "--two-icons"], {
		env: childEnv,
		inherit: true,
	});
	const stage = await mkdtemp(join(tmpdir(), "flowstoken-mac-containers-"));
	try {
		const config = {
			appId: brand.appId,
			productName: brand.productName,
			executableName: brand.executableName,
			electronVersion: before.electronVersion,
			npmRebuild: false,
			publish: [{ provider: "generic", url: embeddedUpdate.url, useMultipleRangeRequest: true }],
			...settings.options,
			mac: { ...settings.mac, icon: resourcePath(packageRoot, settings.mac.icon) },
			dmg: { ...settings.dmg, background: resourcePath(packageRoot, settings.dmg.background) },
			directories: { output, buildResources: join(packageRoot, "build") },
		};
		const { resolveReleaseInfo } = await import(
			pathToFileURL(join(packageRoot, "scripts/resolve-release-info.mjs")).href
		);
		const releaseInfo = resolveReleaseInfo(join(packageRoot, "CHANGELOG.md"), version);
		if (releaseInfo) config.releaseInfo = releaseInfo;
		for (const file of [config.mac.icon, config.dmg.background])
			assert((await stat(file)).isFile(), "missing source container resource");
		await writeFile(
			join(stage, "package.json"),
			JSON.stringify({
				name: settings.packageName,
				version,
				description: settings.description,
				main: "main/index.js",
			}),
		);
		const configPath = join(stage, "electron-builder.json");
		await writeFile(configPath, JSON.stringify(config));
		await mkdir(output, { recursive: true });
		let buildError;
		try {
			await run(
				process.execPath,
				[
					join(dirname(builderPackagePath), "cli.js"),
					`--project=${stage}`,
					`--config=${configPath}`,
					"--prepackaged",
					app,
					"--mac",
					"dmg",
					"zip",
					`--${arch}`,
					"--publish=never",
				],
				{ cwd: sourceRoot, env: childEnv, inherit: true },
			);
		} catch (error) {
			buildError = error;
		}
		const after = await inspectApp(app, brand, version, arch, run);
		assert(
			after.cdhash === before.cdhash && after.teamId === before.teamId,
			"signed app changed during container packaging",
		);
		if (buildError) throw buildError;
		// The normal checkpoint also needs its unpacked app for the existing packaged E2E gate.
		const checkpointApp = join(output, arch === "arm64" ? "mac-arm64" : "mac", basename(app));
		assert(
			!(await stat(checkpointApp).catch((error) => {
				if (error.code === "ENOENT") return null;
				throw error;
			})),
			"checkpoint app already exists",
		);
		await mkdir(dirname(checkpointApp), { recursive: true });
		await run("/usr/bin/ditto", [app, checkpointApp]);
		const copied = await inspectApp(checkpointApp, brand, version, arch, run);
		assert(
			copied.cdhash === before.cdhash && copied.teamId === before.teamId,
			"checkpoint copy differs from the original signed app",
		);
		const metadata = parse(await readFile(join(output, "latest-mac.yml"), "utf8"));
		assert(metadata.version === version, "repackaged update metadata version mismatch");
		const files = await readdir(output);
		for (const extension of [".dmg", ".zip"]) {
			const artifacts = files.filter((file) => file.endsWith(extension));
			assert(
				artifacts.length === 1 && (await stat(join(output, artifacts[0]))).size > 0,
				`missing ${extension} container`,
			);
			if (extension === ".zip")
				assert((await stat(join(output, `${artifacts[0]}.blockmap`))).size > 0, "missing ZIP blockmap");
		}
		await run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				"const {verifyMacUpdate}=await import(process.argv[1]); await verifyMacUpdate({releaseDir:process.argv[2],requireSignature:true});",
				pathToFileURL(join(packageRoot, "scripts/verify-mac-update.mjs")).href,
				output,
			],
			{ env: { ...childEnv, VETTA_REQUIRE_MAC_SIGNATURE: "1" }, inherit: true },
		);
		const proof = {
			schema: 1,
			sourceSha,
			version,
			arch,
			appId: brand.appId,
			cdhash: before.cdhash,
			teamId: before.teamId,
			builderVersion: BUILDER_VERSION,
			checkpointApp: relative(output, checkpointApp),
		};
		await writeFile(join(output, "recovery-repackage.json"), `${JSON.stringify(proof, null, 2)}\n`);
		return proof;
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

async function main() {
	const { values } = parseArgs({
		options: Object.fromEntries(
			["app", "source-root", "source-sha", "output", "arch"].map((key) => [key, { type: "string" }]),
		),
	});
	const proof = await repackageNotarizedMac({
		app: values.app,
		sourceRoot: values["source-root"],
		sourceSha: values["source-sha"],
		output: values.output,
		arch: values.arch,
	});
	console.info(
		`[repackage-mac] verified containers for ${proof.sourceSha} ${proof.version} ${proof.arch}; app CDHash unchanged`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
