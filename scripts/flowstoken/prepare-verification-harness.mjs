import { createHash } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assertSourceCheckout } from "./recover-release.mjs";
import { checkpoint } from "./release-artifacts.mjs";
import {
	RECOVERY_PLATFORMS,
	recoveryPlanDigest,
	VERIFICATION_HARNESS_INPUTS,
	validateRecoveryPlan,
} from "./release-recovery-identity.mjs";

function sha256(body) {
	return createHash("sha256").update(body).digest("hex");
}
function contained(root, path) {
	const value = relative(root, path);
	return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}
function allowedTooling(path) {
	return VERIFICATION_HARNESS_INPUTS.some(
		(input) => path === input || (input === "apps/desktop/e2e" && path.startsWith(`${input}/`)),
	);
}

function linkWindowsDependencies(modules, destination, sourceRoot) {
	function linkEntry(source, target) {
		const original = realpathSync(source);
		if (!contained(sourceRoot, original))
			throw new Error("Verification dependencies must remain inside the original source checkout");
		const info = statSync(original);
		if (info.isDirectory()) symlinkSync(original, target, "junction");
		else if (info.isFile()) copyFileSync(original, target);
		else throw new Error("Verification dependency is not a regular file or directory");
	}
	// Bun's Windows launchers resolve package links from the harness path. An outer
	// node_modules junction relocates isolated-linker relative targets, so resolve each package first.
	mkdirSync(destination);
	for (const name of readdirSync(modules)) {
		const source = join(modules, name);
		const target = join(destination, name);
		if (name.startsWith("@") && statSync(source).isDirectory()) {
			mkdirSync(target);
			for (const packageName of readdirSync(source)) linkEntry(join(source, packageName), join(target, packageName));
		} else linkEntry(source, target);
	}
}

export async function prepareVerificationHarness({
	controllerRoot,
	sourceRoot,
	destination,
	plan,
	controllerSha,
	sourceSha,
	runId,
	attempt,
	platform,
	hostPlatform = process.platform,
}) {
	validateRecoveryPlan(plan, { controllerSha, recoveryRun: runId, "source.sha": sourceSha });
	if (!RECOVERY_PLATFORMS.includes(platform) || !Number.isSafeInteger(attempt) || attempt < 1)
		throw new Error("Invalid verification job identity");
	controllerRoot = realpathSync(controllerRoot);
	sourceRoot = realpathSync(sourceRoot);
	destination = join(realpathSync(dirname(resolve(destination))), basename(destination));
	if (contained(sourceRoot, destination) || contained(controllerRoot, destination) || existsSync(destination))
		throw new Error(
			"Verification harness must be a new directory outside application source and controller snapshots",
		);
	assertSourceCheckout(plan, sourceRoot);
	const sourcePackageRoot = join(sourceRoot, "apps/desktop");
	const packageBytes = readFileSync(join(sourcePackageRoot, "package.json"));
	const sourcePackage = JSON.parse(packageBytes);
	if (
		sourcePackage.version !== plan.source.version ||
		sourcePackage.scripts?.["test:e2e"] !== "wdio run ./wdio.conf.ts"
	)
		throw new Error("Original package version or strict E2E entry point differs from the recovery contract");
	await checkpoint(
		join(sourcePackageRoot, "release"),
		{ sha: sourceSha, controllerSha, run: runId, attempt, version: plan.source.version, platform },
		true,
		plan,
	);
	const snapshot = JSON.parse(readFileSync(join(controllerRoot, "controller-verification.json"), "utf8"));
	if (snapshot.schema !== 1 || snapshot.controllerSha !== controllerSha || !Array.isArray(snapshot.files))
		throw new Error("Verification tooling is not bound to this controller commit");
	if (
		snapshot.files.some(
			(file) =>
				!file ||
				typeof file.path !== "string" ||
				!Number.isSafeInteger(file.size) ||
				!/^[a-f\d]{64}$/.test(file.sha256),
		)
	)
		throw new Error("Verification snapshot file metadata is invalid");
	const names = snapshot.files.map((file) => file.path);
	if (
		new Set(names).size !== names.length ||
		!names.some((name) => name.endsWith(".e2e.ts")) ||
		!VERIFICATION_HARNESS_INPUTS.filter((name) => name !== "apps/desktop/e2e").every((name) => names.includes(name))
	)
		throw new Error("Verification snapshot is incomplete or duplicated");
	const verifiedFiles = snapshot.files.map((file) => {
		if (
			!allowedTooling(file.path) ||
			file.path.includes("\\") ||
			file.path.split("/").some((part) => part === ".." || part === ".")
		)
			throw new Error("Verification tooling path escaped its allowed roots");
		const path = join(controllerRoot, file.path);
		if (!lstatSync(path).isFile() || !contained(controllerRoot, realpathSync(path)))
			throw new Error("Verification tooling is not a regular snapshot file");
		const body = readFileSync(path);
		if (body.length !== file.size || sha256(body) !== file.sha256)
			throw new Error(`Controller verification file changed: ${file.path}`);
		return { ...file, target: file.path.slice("apps/desktop/".length) };
	});
	const modules = join(sourcePackageRoot, "node_modules");
	const cliPackagePath = join(modules, "@wdio/cli/package.json");
	if (!statSync(modules).isDirectory() || !contained(sourceRoot, realpathSync(cliPackagePath)))
		throw new Error("WDIO dependencies must come from the original source checkout");
	const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8"));
	if (
		cliPackage.name !== "@wdio/cli" ||
		typeof cliPackage.version !== "string" ||
		typeof cliPackage.bin?.wdio !== "string"
	)
		throw new Error("Original source WDIO dependency is invalid");
	const cliEntry = realpathSync(resolve(dirname(cliPackagePath), cliPackage.bin.wdio));
	if (!statSync(cliEntry).isFile() || !contained(sourceRoot, cliEntry))
		throw new Error("WDIO executable must come from the original source checkout");
	mkdirSync(destination);
	for (const file of verifiedFiles) {
		const target = join(destination, file.target);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(controllerRoot, file.path), target);
	}
	writeFileSync(join(destination, "package.json"), packageBytes);
	const harnessModules = join(destination, "node_modules");
	if (hostPlatform === "win32") linkWindowsDependencies(modules, harnessModules, sourceRoot);
	else symlinkSync(realpathSync(modules), harnessModules, "dir");
	if (realpathSync(resolve(harnessModules, "@wdio/cli", cliPackage.bin.wdio)) !== cliEntry)
		throw new Error("Verification harness cannot resolve the original WDIO executable");
	const manifest = {
		schema: 1,
		phase: "prepared",
		controllerSha,
		verificationToolingSha: controllerSha,
		sourceSha,
		run: runId,
		attempt,
		platform,
		version: plan.source.version,
		recoveryPlanDigest: recoveryPlanDigest(plan),
		sourcePackageSha256: sha256(packageBytes),
		sourceLockSha256: plan.source.configHashes["bun.lock"],
		wdioVersion: cliPackage.version,
		toolingFiles: verifiedFiles.map(({ target, size, sha256: hash }) => ({ path: target, size, sha256: hash })),
	};
	const manifestPath = join(destination, "verification-tooling.json");
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	return { manifest, manifestPath, harnessRoot: destination, packagedRoot: sourcePackageRoot };
}

async function main() {
	const { values } = parseArgs({
		options: Object.fromEntries(
			[
				"controller-root",
				"source-root",
				"destination",
				"plan",
				"controller-sha",
				"source-sha",
				"run",
				"attempt",
				"platform",
			].map((key) => [key, { type: "string" }]),
		),
	});
	const result = await prepareVerificationHarness({
		controllerRoot: values["controller-root"],
		sourceRoot: values["source-root"],
		destination: values.destination,
		plan: JSON.parse(readFileSync(values.plan, "utf8")),
		controllerSha: values["controller-sha"],
		sourceSha: values["source-sha"],
		runId: values.run,
		attempt: Number(values.attempt),
		platform: values.platform,
	});
	appendFileSync(
		process.env.GITHUB_ENV,
		`VETTA_E2E_HARNESS_ROOT=${result.harnessRoot}\nVETTA_E2E_PACKAGED_ROOT=${result.packagedRoot}\nVETTA_E2E_TOOLING_SHA=${result.manifest.controllerSha}\nVETTA_E2E_SOURCE_SHA=${result.manifest.sourceSha}\n`,
	);
	appendFileSync(process.env.GITHUB_OUTPUT, `ready=true\nmanifest=${result.manifestPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
