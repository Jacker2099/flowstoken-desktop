import { spawnSync } from "node:child_process";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installRuntimeArchive, installRuntimeDirectory, runtimeArchiveTarCommand } from "./runtime-archive-installer";

let testRoot = "";

beforeEach(async () => {
	testRoot = await mkdtemp(join(tmpdir(), "vetta-runtime-archive-"));
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(testRoot, { recursive: true, force: true });
});

describe("runtime archive tar selection", () => {
	it.each(["darwin", "linux"] as const)("keeps the native PATH tar on %s", (platform) => {
		expect(runtimeArchiveTarCommand(platform, { SystemRoot: "C:\\Windows" })).toBe("tar");
	});

	it("selects the Windows system tar regardless of PATH or the installation drive", () => {
		expect(
			runtimeArchiveTarCommand("win32", {
				SystemRoot: "D:\\Windows",
				WINDIR: "C:\\Windows",
				PATH: "C:\\Program Files\\Git\\usr\\bin",
			}),
		).toBe("D:\\Windows\\System32\\tar.exe");
	});

	it("accepts WINDIR when SystemRoot is absent", () => {
		expect(runtimeArchiveTarCommand("win32", { WINDIR: "E:/Windows" })).toBe("E:\\Windows\\System32\\tar.exe");
	});

	it.each([undefined, "", "Windows", "C:Windows"])("rejects an absent or relative Windows system root: %s", (root) => {
		expect(() => runtimeArchiveTarCommand("win32", { SystemRoot: root })).toThrow(
			"Windows system tar requires an absolute SystemRoot or WINDIR",
		);
	});
});

describe("installRuntimeArchive", () => {
	it("extracts a complete runtime before replacing the target directory", async () => {
		const sourceRoot = join(testRoot, "source");
		const sourceRuntime = join(sourceRoot, "runtime", "bin");
		await mkdir(sourceRuntime, { recursive: true });
		await writeFile(join(sourceRuntime, "tool"), "new-runtime", "utf8");

		const archivePath = join(testRoot, "runtime.tar.gz");
		const archive = spawnSync(runtimeArchiveTarCommand(), ["-czf", archivePath, "-C", sourceRoot, "runtime"], {
			encoding: "utf8",
		});
		expect(archive.status, archive.stderr || archive.stdout).toBe(0);

		const targetDirectory = join(testRoot, "managed", "22.22.2");
		await mkdir(targetDirectory, { recursive: true });
		await writeFile(join(targetDirectory, "stale"), "stale", "utf8");

		await installRuntimeArchive({
			archivePath,
			archiveType: "tar.gz",
			innerDirectory: "runtime",
			targetDirectory,
		});

		await expect(readFile(join(targetDirectory, "bin", "tool"), "utf8")).resolves.toBe("new-runtime");
		await expect(readFile(join(targetDirectory, "stale"), "utf8")).rejects.toThrow();
		await expect(readdir(join(testRoot, "managed"))).resolves.toEqual(["22.22.2"]);
	});

	it.runIf(process.platform === "win32")("extracts the Node ZIP format used by Windows releases", async () => {
		const sourceRoot = join(testRoot, "source");
		const sourceRuntime = join(sourceRoot, "node-v22.22.2-win-x64");
		await mkdir(sourceRuntime, { recursive: true });
		await writeFile(join(sourceRuntime, "node.exe"), "node-runtime", "utf8");

		const archivePath = join(testRoot, "node.zip");
		const archive = spawnSync(
			runtimeArchiveTarCommand(),
			["-a", "-cf", archivePath, "-C", sourceRoot, "node-v22.22.2-win-x64"],
			{
				encoding: "utf8",
			},
		);
		expect(archive.status, archive.stderr || archive.stdout).toBe(0);

		const targetDirectory = join(testRoot, "managed", "22.22.2");
		await installRuntimeArchive({
			archivePath,
			archiveType: "zip",
			innerDirectory: "node-v22.22.2-win-x64",
			targetDirectory,
		});

		await expect(readFile(join(targetDirectory, "node.exe"), "utf8")).resolves.toBe("node-runtime");
	});

	it.runIf(process.platform === "win32")(
		"installs a root-level MinGit ZIP while a different tar shadows PATH",
		async () => {
			const sourceRoot = join(testRoot, "source");
			await mkdir(join(sourceRoot, "cmd"), { recursive: true });
			await writeFile(join(sourceRoot, "cmd", "git.exe"), "managed-git", "utf8");
			const archivePath = join(testRoot, "mingit.zip");
			const archive = spawnSync(runtimeArchiveTarCommand(), ["-a", "-cf", archivePath, "-C", sourceRoot, "cmd"], {
				encoding: "utf8",
			});
			expect(archive.status, archive.stderr || archive.stdout).toBe(0);

			const poisonDirectory = join(testRoot, "path-poison");
			await mkdir(poisonDirectory);
			// A real executable with a different protocol proves that PATH lookup is unsafe.
			await copyFile(process.execPath, join(poisonDirectory, "tar.exe"));
			const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
			vi.stubEnv(pathKey, `${poisonDirectory}${delimiter}${process.env[pathKey] ?? ""}`);
			const shadowed = spawnSync("tar", ["--version"], { encoding: "utf8" });
			expect(shadowed.status, shadowed.stderr).toBe(0);
			expect(shadowed.stdout.trim()).toBe(process.version);
			const oldExtractionDirectory = join(testRoot, "old-path-extraction");
			await mkdir(oldExtractionDirectory);
			const oldExtraction = spawnSync("tar", ["-xf", archivePath, "-C", oldExtractionDirectory], {
				encoding: "utf8",
			});
			expect(oldExtraction.status).not.toBe(0);
			await expect(readdir(oldExtractionDirectory)).resolves.toEqual([]);

			const targetDirectory = join(testRoot, "managed", "git");
			await mkdir(targetDirectory, { recursive: true });
			await writeFile(join(targetDirectory, "stale"), "old-git", "utf8");
			await installRuntimeArchive({ archivePath, archiveType: "zip", innerDirectory: "", targetDirectory });
			await expect(readFile(join(targetDirectory, "cmd", "git.exe"), "utf8")).resolves.toBe("managed-git");
			await expect(readFile(join(targetDirectory, "stale"), "utf8")).rejects.toThrow();
			await expect(readdir(join(testRoot, "managed"))).resolves.toEqual(["git"]);
		},
	);

	it.runIf(process.platform === "win32")(
		"preserves the existing runtime when the selected system tar is missing",
		async () => {
			const targetDirectory = join(testRoot, "managed", "22.22.2");
			await mkdir(targetDirectory, { recursive: true });
			await writeFile(join(targetDirectory, "node.exe"), "existing-runtime", "utf8");
			const archivePath = join(testRoot, "unused.zip");
			await writeFile(archivePath, "invalid archive", "utf8");
			vi.stubEnv("SystemRoot", join(testRoot, "missing-windows"));

			await expect(
				installRuntimeArchive({ archivePath, archiveType: "zip", innerDirectory: "node", targetDirectory }),
			).rejects.toThrow("extract failed");
			await expect(readFile(join(targetDirectory, "node.exe"), "utf8")).resolves.toBe("existing-runtime");
			await expect(readdir(join(testRoot, "managed"))).resolves.toEqual(["22.22.2"]);
		},
	);

	it("preserves an existing runtime when extraction fails", async () => {
		const targetDirectory = join(testRoot, "managed", "3.13.12");
		await mkdir(targetDirectory, { recursive: true });
		await writeFile(join(targetDirectory, "python.exe"), "existing-runtime", "utf8");
		const archivePath = join(testRoot, "broken.tar.gz");
		await writeFile(archivePath, "not an archive", "utf8");

		await expect(
			installRuntimeArchive({
				archivePath,
				archiveType: "tar.gz",
				innerDirectory: "python",
				targetDirectory,
			}),
		).rejects.toThrow("extract failed");

		await expect(readFile(join(targetDirectory, "python.exe"), "utf8")).resolves.toBe("existing-runtime");
		await expect(readdir(join(testRoot, "managed"))).resolves.toEqual(["3.13.12"]);
	});
});

describe("installRuntimeDirectory", () => {
	it("copies a bundled runtime directory over the target", async () => {
		const sourceDirectory = join(testRoot, "vendor", "python");
		await mkdir(join(sourceDirectory, "bin"), { recursive: true });
		await writeFile(join(sourceDirectory, "bin", "python3.13"), "bundled-runtime", "utf8");

		const targetDirectory = join(testRoot, "managed", "3.13.12");
		await mkdir(targetDirectory, { recursive: true });
		await writeFile(join(targetDirectory, "stale"), "stale", "utf8");

		await installRuntimeDirectory({ sourceDirectory, targetDirectory });

		await expect(readFile(join(targetDirectory, "bin", "python3.13"), "utf8")).resolves.toBe("bundled-runtime");
		await expect(readFile(join(targetDirectory, "stale"), "utf8")).rejects.toThrow();
		await expect(readdir(join(testRoot, "managed"))).resolves.toEqual(["3.13.12"]);
	});

	// python-build-standalone 与 Node 官方包都用符号链接（python3 -> python3.13），
	// 解引用会让运行时体积翻倍，可执行位丢失则 seed 出来的运行时直接不可用。
	it.runIf(process.platform !== "win32")("preserves symlinks and the executable bit", async () => {
		const sourceDirectory = join(testRoot, "vendor", "python");
		await mkdir(join(sourceDirectory, "bin"), { recursive: true });
		const realBinary = join(sourceDirectory, "bin", "python3.13");
		await writeFile(realBinary, "bundled-runtime", "utf8");
		await chmod(realBinary, 0o755);
		await symlink("python3.13", join(sourceDirectory, "bin", "python3"));

		const targetDirectory = join(testRoot, "managed", "3.13.12");
		await installRuntimeDirectory({ sourceDirectory, targetDirectory });

		const copiedLink = join(targetDirectory, "bin", "python3");
		await expect(lstat(copiedLink).then((info) => info.isSymbolicLink())).resolves.toBe(true);
		await expect(readlink(copiedLink)).resolves.toBe("python3.13");
		const mode = (await lstat(join(targetDirectory, "bin", "python3.13"))).mode & 0o777;
		expect(mode & 0o111).not.toBe(0);
	});

	it("preserves an existing runtime when the source is missing", async () => {
		const targetDirectory = join(testRoot, "managed", "3.13.12");
		await mkdir(targetDirectory, { recursive: true });
		await writeFile(join(targetDirectory, "python3"), "existing-runtime", "utf8");

		await expect(
			installRuntimeDirectory({ sourceDirectory: join(testRoot, "vendor", "absent"), targetDirectory }),
		).rejects.toThrow();

		await expect(readFile(join(targetDirectory, "python3"), "utf8")).resolves.toBe("existing-runtime");
	});
});
