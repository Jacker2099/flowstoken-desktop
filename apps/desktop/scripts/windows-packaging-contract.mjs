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
