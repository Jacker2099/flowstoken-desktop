import { win32 } from "node:path";

export const WINDOWS_RELEASE_TARGETS = Object.freeze(["inno", "zip"]);

export const WINDOWS_SUPPLEMENTAL_EXTENSIONS = Object.freeze([".zip"]);

function resolveWindowsArtifactProductName() {
	const value = process.env.VETTA_PRODUCT_NAME?.trim();
	return value && value.length > 0 ? value : "Vetta";
}

export function windowsSupplementalArtifactNames(version) {
	const productName = resolveWindowsArtifactProductName();
	return WINDOWS_SUPPLEMENTAL_EXTENSIONS.map((extension) => `${productName}-${version}-win-x64${extension}`);
}

// Packaging scripts run directly on Node; keep this policy independent of TS/Electron.
export function windowsSystemTarCommand(env = process.env) {
	const systemRoot = env.SystemRoot || env.WINDIR;
	if (!systemRoot || !win32.isAbsolute(systemRoot)) {
		throw new Error("Windows system tar requires an absolute SystemRoot or WINDIR");
	}
	return win32.join(systemRoot, "System32", "tar.exe");
}
