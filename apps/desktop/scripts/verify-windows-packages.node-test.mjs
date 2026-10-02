import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { windowsSupplementalArtifactNames, windowsSystemTarCommand } from "./windows-packaging-contract.mjs";
import {
	readExpectedWindowsVersion,
	verifyExtractedWindowsLayout,
	verifyWindowsPackages,
} from "./verify-windows-packages.mjs";

async function createLayout(root, version, executableName = "Vetta") {
	const versionDir = join(root, "versions", version);
	await mkdir(join(versionDir, "resources"), { recursive: true });
	await Promise.all([
		writeFile(join(root, `${executableName}.exe`), "launcher"),
		writeFile(join(root, "current.json"), `${JSON.stringify({ version })}\n`),
		writeFile(join(versionDir, `${executableName}.exe`), "application"),
		writeFile(join(versionDir, "resources", "app.asar"), "archive"),
	]);
}

test("Windows supplemental package names are stable and versioned", () => {
	const previous = process.env.VETTA_PRODUCT_NAME;
	delete process.env.VETTA_PRODUCT_NAME;
	try {
		assert.deepEqual(windowsSupplementalArtifactNames("1.2.3"), ["Vetta-1.2.3-win-x64.zip"]);
		process.env.VETTA_PRODUCT_NAME = "FlowsToken";
		assert.deepEqual(windowsSupplementalArtifactNames("1.2.3"), ["FlowsToken-1.2.3-win-x64.zip"]);
	} finally {
		if (previous === undefined) delete process.env.VETTA_PRODUCT_NAME;
		else process.env.VETTA_PRODUCT_NAME = previous;
	}
});

test("Windows ZIP verification selects system tar independently of PATH and the installation drive", () => {
	assert.equal(
		windowsSystemTarCommand({ SystemRoot: "D:\\Windows", WINDIR: "C:\\Windows", PATH: "C:\\Git\\usr\\bin" }),
		"D:\\Windows\\System32\\tar.exe",
	);
	assert.equal(windowsSystemTarCommand({ WINDIR: "E:/Windows" }), "E:\\Windows\\System32\\tar.exe");
	for (const root of [undefined, "", "Windows", "C:Windows"])
		assert.throws(() => windowsSystemTarCommand({ SystemRoot: root }), /absolute SystemRoot or WINDIR/);
});

test(
	"the public Windows verifier uses real ZIP extraction when a different executable shadows PATH",
	{ skip: process.platform !== "win32" },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "vetta-native-zip-verification-"));
		const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
		const previous = Object.fromEntries(
			[pathKey, "VETTA_PRODUCT_NAME", "VETTA_EXECUTABLE_NAME"].map((key) => [key, process.env[key]]),
		);
		try {
			process.env.VETTA_PRODUCT_NAME = "FlowsToken";
			process.env.VETTA_EXECUTABLE_NAME = "FlowsToken";
			const releaseDir = join(root, "release");
			const source = join(root, "source");
			await mkdir(releaseDir);
			await createLayout(source, "1.2.3", "FlowsToken");
			await writeFile(join(releaseDir, "latest.yml"), "version: 1.2.3\n");
			const zipPath = join(releaseDir, windowsSupplementalArtifactNames("1.2.3")[0]);
			const archive = spawnSync(windowsSystemTarCommand(), ["-a", "-cf", zipPath, "-C", source, "."], {
				encoding: "utf8",
			});
			assert.equal(archive.status, 0, archive.stderr);

			const poison = join(root, "path-poison");
			await mkdir(poison);
			await copyFile(process.execPath, join(poison, "tar.exe"));
			process.env[pathKey] = `${poison}${delimiter}${previous[pathKey] ?? ""}`;
			const shadowed = spawnSync("tar.exe", ["--version"], { encoding: "utf8" });
			assert.equal(shadowed.status, 0, shadowed.stderr);
			assert.equal(shadowed.stdout.trim(), process.version);
			const oldDestination = join(root, "old-path-extraction");
			await mkdir(oldDestination);
			assert.notEqual(spawnSync("tar.exe", ["-xf", zipPath, "-C", oldDestination]).status, 0);
			assert.deepEqual(await readdir(oldDestination), []);

			assert.deepEqual(await verifyWindowsPackages({ releaseDir }), { version: "1.2.3", zipPath });
			// Real driver checks must still reject corrupted ZIP bytes and incomplete/mismatched layouts.
			await rm(join(source, "versions", "1.2.3", "resources", "app.asar"));
			const incomplete = spawnSync(windowsSystemTarCommand(), ["-a", "-cf", zipPath, "-C", source, "."], {
				encoding: "utf8",
			});
			assert.equal(incomplete.status, 0, incomplete.stderr);
			await assert.rejects(verifyWindowsPackages({ releaseDir }), /expected one complete 1\.2\.3 layout/);
			await writeFile(zipPath, "invalid ZIP bytes");
			await assert.rejects(verifyWindowsPackages({ releaseDir }));
			await createLayout(source, "1.2.2", "FlowsToken");
			const wrongVersion = spawnSync(windowsSystemTarCommand(), ["-a", "-cf", zipPath, "-C", source, "."], {
				encoding: "utf8",
			});
			assert.equal(wrongVersion.status, 0, wrongVersion.stderr);
			await assert.rejects(verifyWindowsPackages({ releaseDir }), /expected one complete 1\.2\.3 layout/);
			await createLayout(source, "1.2.3", "FlowsToken");
			await createLayout(join(source, "duplicate"), "1.2.3", "FlowsToken");
			const duplicate = spawnSync(windowsSystemTarCommand(), ["-a", "-cf", zipPath, "-C", source, "."], {
				encoding: "utf8",
			});
			assert.equal(duplicate.status, 0, duplicate.stderr);
			await assert.rejects(verifyWindowsPackages({ releaseDir }), /found 2/);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("Windows package inspection accepts the versioned launcher layout at any extraction depth", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-windows-package-layout-"));
	try {
		const layoutRoot = join(root, "Program Files", "Vetta");
		await createLayout(layoutRoot, "1.2.3");
		assert.equal(await verifyExtractedWindowsLayout(root, "1.2.3"), layoutRoot);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Windows package inspection rejects an incomplete or wrong-version layout", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-windows-package-layout-"));
	try {
		await createLayout(root, "1.2.2");
		await assert.rejects(() => verifyExtractedWindowsLayout(root, "1.2.3"), /expected one complete 1\.2\.3 layout/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Windows package verification uses the Inno update manifest version", async () => {
	const releaseDir = await mkdtemp(join(tmpdir(), "vetta-windows-packages-"));
	try {
		await writeFile(join(releaseDir, "latest.yml"), "version: 9.8.7\n");
		assert.equal(await readExpectedWindowsVersion(releaseDir), "9.8.7");
	} finally {
		await rm(releaseDir, { recursive: true, force: true });
	}
});
