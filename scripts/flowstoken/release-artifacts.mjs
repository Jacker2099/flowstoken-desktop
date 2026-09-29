import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const downloadable = /\.(?:AppImage|blockmap|deb|dmg|exe|msi|rpm|zip)$|^latest.*\.yml$/;

export async function digest(file, algorithm = "sha256", encoding = "hex") {
	const hash = createHash(algorithm);
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest(encoding);
}

async function inspectFiles(directory, names) {
	return Promise.all(
		names.sort().map(async (name) => {
			if (basename(name) !== name || !/^[\w.-]+$/.test(name)) throw new Error(`Unsafe release filename: ${name}`);
			const info = await lstat(join(directory, name));
			if (!info.isFile() || info.size < 1) throw new Error(`Invalid release file: ${name}`);
			return { name, size: info.size, sha256: await digest(join(directory, name)) };
		}),
	);
}

export async function checkpoint(directory, identity, verify = false) {
	const names = (await readdir(directory)).filter(
		(name) => downloadable.test(name) && !name.startsWith("._") && !name.startsWith("default._"),
	);
	const files = await inspectFiles(directory, names);
	if (!files.length) throw new Error("Checkpoint contains no release artifacts");
	const path = join(directory, "release-provenance.json");
	if (verify) {
		const saved = JSON.parse(await readFile(path, "utf8"));
		for (const key of ["sha", "run", "version", "platform"]) {
			if (saved[key] !== identity[key]) throw new Error(`Checkpoint ${key} differs from requested release`);
		}
		// Successful jobs may retain their checkpoint when only failed jobs are rerun.
		if (!Number.isSafeInteger(saved.attempt) || saved.attempt < 1 || saved.attempt > identity.attempt) {
			throw new Error("Checkpoint attempt is invalid");
		}
		if (JSON.stringify(saved.files) !== JSON.stringify(files)) throw new Error("Checkpoint artifact hashes changed");
	} else {
		if (
			!/^[a-f\d]{40}$/.test(identity.sha) ||
			!/^\d+$/.test(identity.run) ||
			!/^\d+\.\d+\.\d+$/.test(identity.version) ||
			!Number.isSafeInteger(identity.attempt) ||
			identity.attempt < 1
		) {
			throw new Error("Incomplete checkpoint identity");
		}
		await writeFile(path, `${JSON.stringify({ ...identity, files }, null, 2)}\n`);
	}
}

export async function verifyReleaseArtifacts(directory, identity) {
	const { parse } = require("yaml");
	const expected = new Set(["latest.yml", "latest-linux.yml", "latest-mac.yml"]);
	const artifactGroups = {};
	for (const feed of [...expected]) {
		const metadata = parse(await readFile(join(directory, feed), "utf8"));
		if (metadata.version !== identity.version || !Array.isArray(metadata.files) || metadata.files.length === 0)
			throw new Error(`Invalid release version/files: ${feed}`);
		const urls = [];
		for (const file of metadata.files) {
			if (
				typeof file.url !== "string" ||
				!file.url.startsWith(`FlowsToken-${identity.version}`) ||
				!["-", "."].includes(file.url[`FlowsToken-${identity.version}`.length]) ||
				!/^[\w.-]+$/.test(file.url)
			)
				throw new Error(`Invalid artifact URL: ${feed}`);
			if (expected.has(file.url)) throw new Error(`Duplicate artifact: ${file.url}`);
			const info = await lstat(join(directory, file.url));
			if (
				!info.isFile() ||
				info.size !== file.size ||
				(await digest(join(directory, file.url), "sha512", "base64")) !== file.sha512
			)
				throw new Error(`Artifact size/hash mismatch: ${file.url}`);
			expected.add(file.url);
			urls.push(file.url);
		}
		const primary = metadata.files.find((file) => file.url === metadata.path);
		if (!primary || primary.sha512 !== metadata.sha512) throw new Error(`Invalid primary artifact: ${feed}`);
		artifactGroups[feed] = urls;
	}
	const extensions = (names) => names.map((name) => name.split(".").at(-1)).sort();
	if (JSON.stringify(extensions(artifactGroups["latest.yml"])) !== JSON.stringify(["exe"]))
		throw new Error("Windows update must contain one EXE");
	if (JSON.stringify(extensions(artifactGroups["latest-linux.yml"])) !== JSON.stringify(["AppImage", "deb", "rpm"]))
		throw new Error("Linux update must contain AppImage, DEB and RPM");
	const mac = artifactGroups["latest-mac.yml"];
	for (const arm64 of [true, false]) {
		if (
			JSON.stringify(extensions(mac.filter((name) => name.includes("arm64") === arm64))) !==
			JSON.stringify(["dmg", "zip"])
		)
			throw new Error("macOS update must contain DMG and ZIP for each architecture");
	}
	const windowsZip = `FlowsToken-${identity.version}-win-x64.zip`;
	expected.add(windowsZip);
	for (const name of [...artifactGroups["latest.yml"], ...mac.filter((name) => name.endsWith(".zip"))])
		expected.add(`${name}.blockmap`);
	const present = await readdir(directory);
	// Some builder versions emit additional blockmaps. They must belong to a verified installer.
	for (const name of present) if (name.endsWith(".blockmap") && expected.has(name.slice(0, -9))) expected.add(name);
	const actual = present.filter((name) => name !== "release-manifest.json").sort();
	if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
		throw new Error("Release contains missing or unexpected assets");
	const files = await inspectFiles(directory, [...expected]);
	const manifest = { ...identity, files };
	await writeFile(join(directory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

async function main() {
	const { values } = parseArgs({
		options: Object.fromEntries(
			["dir", "version", "sha", "run", "attempt", "platform", "mode"].map((name) => [name, { type: "string" }]),
		),
	});
	const { dir, mode, ...identity } = values;
	identity.attempt = Number(identity.attempt);
	if (mode === "checkpoint" || mode === "check-checkpoint")
		await checkpoint(resolve(dir), identity, mode === "check-checkpoint");
	else if (mode === "release") await verifyReleaseArtifacts(resolve(dir), identity);
	else throw new Error("Expected checkpoint, check-checkpoint or release mode");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
