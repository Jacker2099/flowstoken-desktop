import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const PACKAGE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

function resolveProductName() {
	const value = process.env.VETTA_PRODUCT_NAME?.trim();
	return value && value.length > 0 ? value : "Vetta";
}

function resolveExecutableName() {
	const value = process.env.VETTA_EXECUTABLE_NAME?.trim() || process.env.VETTA_PRODUCT_NAME?.trim();
	return value && value.length > 0 ? value : "Vetta";
}

function resolveWindowsVersionedBinary(unpackedRoot) {
	const pointerPath = join(unpackedRoot, "current.json");
	let pointer;
	try {
		pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read Windows packaged version pointer: ${pointerPath}`, { cause: error });
	}

	const version = pointer?.version;
	if (
		typeof version !== "string" ||
		version === "." ||
		version === ".." ||
		!PACKAGE_VERSION_PATTERN.test(version)
	) {
		throw new Error(`Windows packaged E2E has an invalid version pointer: ${String(version)}`);
	}
	const executableName = resolveExecutableName();
	return join(unpackedRoot, "versions", version, `${executableName}.exe`);
}

export function resolvePackagedE2eAppImagePath(packageRoot, version) {
	if (typeof version !== "string" || !PACKAGE_VERSION_PATTERN.test(version)) {
		throw new Error(`Linux packaged E2E has an invalid application version: ${String(version)}`);
	}
	const productName = resolveProductName();
	const appImagePath = join(packageRoot, "release", `${productName}-${version}.AppImage`);
	if (existsSync(appImagePath)) return appImagePath;
	// Upstream / older artifacts may still use Vetta-*
	const legacyPath = join(packageRoot, "release", `Vetta-${version}.AppImage`);
	if (productName !== "Vetta" && existsSync(legacyPath)) return legacyPath;
	throw new Error(
		`Linux packaged E2E AppImage not found: ${appImagePath}. Run bun run dist:linux:test first.`,
	);
}

export function stagePackagedE2eAppImage(packageRoot, version, temporaryRoot = tmpdir()) {
	const sourcePath = resolvePackagedE2eAppImagePath(packageRoot, version);
	const stagingRoot = mkdtempSync(join(temporaryRoot, "vetta-packaged-e2e-appimage-"));
	const appImagePath = join(stagingRoot, basename(sourcePath));
	try {
		copyFileSync(sourcePath, appImagePath);
		return { appImagePath, stagingRoot };
	} catch (error) {
		rmSync(stagingRoot, { recursive: true, force: true });
		throw error;
	}
}

/**
 * electron-builder writes resources/package-type into the shared linux-unpacked
 * directory while building deb/rpm. electron-updater then picks the deb/rpm
 * updater instead of the AppImage one, so the AppImage-backed E2E must drop it.
 */
export function clearLinuxUnpackedPackageType(packageRoot) {
	rmSync(join(packageRoot, "release", "linux-unpacked", "resources", "package-type"), { force: true });
}

export function resolvePackagedE2eBinaryPath(packageRoot, platform = process.platform) {
	const releaseRoot = join(packageRoot, "release");
	const productName = resolveProductName();
	const executableName = resolveExecutableName();
	const candidates =
		platform === "win32"
			? [resolveWindowsVersionedBinary(join(releaseRoot, "win-unpacked"))]
			: platform === "darwin"
				? [
						join(releaseRoot, "mac-arm64", `${productName}.app`, "Contents", "MacOS", executableName),
						join(releaseRoot, "mac", `${productName}.app`, "Contents", "MacOS", executableName),
						join(releaseRoot, "mac-x64", `${productName}.app`, "Contents", "MacOS", executableName),
						// Upstream fallback
						join(releaseRoot, "mac-arm64", "Vetta.app", "Contents", "MacOS", "Vetta"),
						join(releaseRoot, "mac", "Vetta.app", "Contents", "MacOS", "Vetta"),
						join(releaseRoot, "mac-x64", "Vetta.app", "Contents", "MacOS", "Vetta"),
					]
				: platform === "linux"
					? [
							join(releaseRoot, "linux-unpacked", executableName),
							join(releaseRoot, "linux-unpacked", "Vetta"),
						]
					: [];

	const found = candidates.find((candidate) => existsSync(candidate));
	if (found) return found;
	throw new Error(
		[
			`Packaged Electron binary not found for ${platform}. Run a pack script for this platform first, e.g.:`,
			"  bun run pack:win:test",
			"  bun run pack:linux:test",
			`Tried:\n${candidates.map((candidate) => `  - ${candidate}`).join("\n")}`,
		].join("\n"),
	);
}
