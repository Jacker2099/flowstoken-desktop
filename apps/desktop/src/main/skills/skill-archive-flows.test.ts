import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { delimiter, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeArchiveTarCommand } from "../runtimes/runtime-archive-installer.js";

const fixture = vi.hoisted(() => ({
	home: "",
	events: [] as unknown[],
	handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));

vi.mock("@vetta/action-rpc", () => ({ getVettaHomePath: () => fixture.home }));
vi.mock("../logger.js", () => ({
	getAppLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../app-monitor/app-monitor-service.js", () => ({
	recordAppMonitorEvent: (event: unknown) => fixture.events.push(event),
}));
// These optional listing/preview dependencies do not own installation or its persistence.
vi.mock("../agent-runtime/resource-runtime.js", () => ({ createDesktopSkillResourceRuntime: vi.fn() }));
vi.mock("../plugins/plugin-catalog.js", () => ({
	listPlugins: () => [],
	pluginAgentContributionService: { buildRuntimeConfig: () => undefined },
}));
vi.mock("../builtin-skills.js", () => ({
	getBuiltinSkillPaths: () => [],
	builtinSkillText: vi.fn(),
	isBuiltinSkillFile: () => false,
	readBuiltinSkillsManifest: () => ({}),
}));
vi.mock("../config/desktop-config-store.js", () => ({ readDesktopConfig: async () => ({}) }));
vi.mock("../i18n/index.js", () => ({ getAppLanguage: () => "en" }));
vi.mock("../ipc/settings.js", () => ({ readSettings: () => ({}) }));
vi.mock("../ipc/fs.js", () => ({ allowProjectRoot: vi.fn() }));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
			fixture.handlers.set(channel, handler);
		},
		removeHandler: (channel: string) => {
			fixture.handlers.delete(channel);
		},
	},
	app: { isPackaged: false, getPath: () => fixture.home, getAppPath: () => fixture.home },
}));

let testRoot = "";
let disposeIpc: (() => void) | undefined;

beforeEach(async () => {
	testRoot = await mkdtemp(join(tmpdir(), "vetta skill archive "));
	fixture.home = join(testRoot, "home $(printf wrong-directory)");
	await mkdir(fixture.home);
	fixture.events.length = 0;
	fixture.handlers.clear();
	vi.resetModules();
	const { getVettaHomePath } = await import("@vetta/action-rpc");
	expect(getVettaHomePath()).toBe(fixture.home);
	const { getSkillBaseDir } = await import("./skill-service.js");
	expect(getSkillBaseDir()).toBe(join(fixture.home, "skills"));
	expect(join(getVettaHomePath(), "tmp")).toBe(join(fixture.home, "tmp"));
});

afterEach(async () => {
	disposeIpc?.();
	disposeIpc = undefined;
	vi.unstubAllEnvs();
	await rm(testRoot, { recursive: true, force: true });
});

function skillMarkdown(name: string, version: string, type: "skill" | "scene" = "skill"): string {
	return `---\nname: ${name}\ndescription: Contains: a colon\nversion: ${version}\nmetadata:\n  type: ${type}\n---\n# ${name}\n`;
}

async function archiveOf(files: Record<string, string | Buffer>, format: "tgz" | "zip" = "tgz"): Promise<Buffer> {
	if (format === "zip") {
		const zip = new AdmZip();
		for (const [path, content] of Object.entries(files)) zip.addFile(path, Buffer.from(content));
		return zip.toBuffer();
	}
	const source = await mkdtemp(join(testRoot, "source with spaces "));
	for (const [path, content] of Object.entries(files)) {
		const target = join(source, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
	const archivePath = join(source, "fixture with spaces.tar.gz");
	const archive = spawnSync(runtimeArchiveTarCommand(), ["-czf", archivePath, "-C", source, ...Object.keys(files)], {
		encoding: "utf8",
	});
	expect(archive.status, archive.stderr || archive.stdout).toBe(0);
	return readFile(archivePath);
}

async function installedState(): Promise<{ manifest: string; ledger: string }> {
	return {
		manifest: await readFile(join(fixture.home, "skills-manifest.json"), "utf8"),
		ledger: await readFile(join(fixture.home, "abilities.json"), "utf8"),
	};
}

async function importArchive(buffer: Buffer): Promise<unknown> {
	if (!disposeIpc) {
		const { registerSkillsIpc } = await import("../ipc/skills.js");
		disposeIpc = registerSkillsIpc();
	}
	const handler = fixture.handlers.get("vetta:skills:import-custom");
	if (!handler) throw new Error("Custom import IPC was not registered");
	return handler({}, buffer);
}

describe("real skill archive installation flows", () => {
	it.runIf(process.platform !== "win32")(
		"preserves relative script links and executable permissions after removing its TGZ stage",
		async () => {
			const source = await mkdtemp(join(testRoot, "linked skill "));
			await mkdir(join(source, "bin"));
			await writeFile(join(source, "SKILL.md"), skillMarkdown("linked-skill", "1.0.0"));
			await writeFile(join(source, "bin", "tool"), "linked-script");
			await chmod(join(source, "bin", "tool"), 0o755);
			await symlink("bin/tool", join(source, "tool-link"));
			const archivePath = join(source, "linked.tar.gz");
			const archive = spawnSync(
				runtimeArchiveTarCommand(),
				["-czf", archivePath, "-C", source, "SKILL.md", "bin", "tool-link"],
				{ encoding: "utf8" },
			);
			expect(archive.status, archive.stderr).toBe(0);
			await expect(importArchive(await readFile(archivePath))).resolves.toEqual({
				name: "linked-skill",
				type: "skill",
			});
			const destination = join(fixture.home, "skills", "linked-skill");
			expect((await lstat(join(destination, "tool-link"))).isSymbolicLink()).toBe(true);
			await expect(readlink(join(destination, "tool-link"))).resolves.toBe("bin/tool");
			await expect(readFile(join(destination, "tool-link"), "utf8")).resolves.toBe("linked-script");
			expect((await lstat(join(destination, "bin", "tool"))).mode & 0o111).not.toBe(0);
			await expect(readdir(join(fixture.home, "tmp"))).resolves.toEqual([]);
		},
	);

	it("does not publish partial members from a truncated custom TGZ or change the prior manifest/events", async () => {
		const initial = await archiveOf({ "SKILL.md": skillMarkdown("market-demo", "1.0.0") });
		await expect(importArchive(initial)).resolves.toEqual({ name: "market-demo", type: "skill" });
		const prior = await installedState();
		const destination = join(fixture.home, "skills", "market-demo");
		const source = await mkdtemp(join(testRoot, "truncated source "));
		await writeFile(join(source, "SKILL.md"), skillMarkdown("market-demo", "99.0.0"));
		await writeFile(join(source, "tail.bin"), randomBytes(512 * 1024));
		const tarPath = join(source, "complete.tar");
		const raw = spawnSync(runtimeArchiveTarCommand(), ["-cf", tarPath, "-C", source, "SKILL.md", "tail.bin"], {
			encoding: "utf8",
		});
		expect(raw.status, raw.stderr).toBe(0);
		const full = gzipSync(await readFile(tarPath));
		const truncated = full.subarray(0, full.length - 64 * 1024);
		const truncatedPath = join(source, "truncated.tar.gz");
		await writeFile(truncatedPath, truncated);
		const unsafeDestination = join(testRoot, "old direct extraction");
		await mkdir(unsafeDestination);
		await writeFile(join(unsafeDestination, "SKILL.md"), skillMarkdown("market-demo", "1.0.0"));
		const direct = spawnSync(runtimeArchiveTarCommand(), ["-xzf", truncatedPath, "-C", unsafeDestination], {
			encoding: "utf8",
		});
		expect(direct.status).not.toBe(0);
		await expect(readFile(join(unsafeDestination, "SKILL.md"), "utf8")).resolves.toContain("version: 99.0.0");

		await expect(importArchive(truncated)).rejects.toThrow();
		await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toContain("version: 1.0.0");
		expect(await installedState()).toEqual(prior);
		expect(fixture.events).toHaveLength(1);
		await expect(readdir(join(fixture.home, "tmp"))).resolves.toEqual([]);
	});

	it.each(["tgz", "zip"] as const)(
		"imports a custom skill archive through the registered IPC using real %s, then rejects a duplicate",
		async (format) => {
			const buffer = await archiveOf(
				{ "package/SKILL.md": skillMarkdown("custom-scene", "3.4.5", "scene"), "package/data.txt": "custom-data" },
				format,
			);
			await expect(importArchive(buffer)).resolves.toEqual({ name: "custom-scene", type: "skill" });
			const destination = join(fixture.home, "skills", "custom-scene");
			await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toContain(
				'description: "Contains: a colon"',
			);
			await expect(readFile(join(destination, "data.txt"), "utf8")).resolves.toBe("custom-data");
			const prior = await installedState();
			expect(JSON.parse(prior.manifest) as unknown).toMatchObject({
				"custom-scene": {
					source: "custom",
					type: "skill",
					version: "3.4.5",
					enabled: true,
					description: "Contains: a colon",
				},
			});
			expect(JSON.parse(prior.ledger) as unknown).toMatchObject({
				entries: { "skill:custom-scene": { version: "3.4.5" } },
			});
			expect(fixture.events).toEqual([
				{
					type: "resource.lifecycle",
					resourceKind: "skill",
					operation: "imported",
					resourceId: "custom-scene",
					source: "custom",
				},
			]);
			await expect(importArchive(buffer)).rejects.toThrow("已存在同名技能");
			expect(await installedState()).toEqual(prior);
			expect(fixture.events).toHaveLength(1);
			await expect(readdir(join(fixture.home, "tmp"))).resolves.toEqual([]);
		},
	);

	it.each(["missing-name", "missing-description", "bad-gzip"])(
		"rejects %s in the public custom import and cleans private temporary files",
		async (invalid) => {
			const buffer =
				invalid === "bad-gzip"
					? Buffer.from([0x1f, 0x8b, 8, 0])
					: await archiveOf({
							"SKILL.md":
								invalid === "missing-name"
									? "---\ndescription: test\n---\n"
									: "---\nname: invalid-import\n---\n",
						});
			await expect(importArchive(buffer)).rejects.toThrow();
			await expect(readdir(join(fixture.home, "tmp"))).resolves.toEqual([]);
			await expect(readFile(join(fixture.home, "skills-manifest.json"))).rejects.toThrow();
			await expect(readFile(join(fixture.home, "abilities.json"))).rejects.toThrow();
			expect(fixture.events).toEqual([]);
		},
	);

	it.runIf(process.platform === "win32")(
		"custom TGZ imports use the system tool despite a real PATH tar poison",
		async () => {
			const custom = await archiveOf({ "SKILL.md": skillMarkdown("custom-poison", "2.0.0") });
			const poisonDirectory = join(testRoot, "path poison");
			await mkdir(poisonDirectory);
			await copyFile(process.execPath, join(poisonDirectory, "tar.exe"));
			const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
			vi.stubEnv(pathKey, `${poisonDirectory}${delimiter}${process.env[pathKey] ?? ""}`);
			const unsafe = spawnSync("tar", ["--version"], { encoding: "utf8" });
			expect(unsafe.status, unsafe.stderr).toBe(0);
			expect(unsafe.stdout.trim()).toBe(process.version);
			await expect(importArchive(custom)).resolves.toEqual({ name: "custom-poison", type: "skill" });
			await expect(readFile(join(fixture.home, "skills", "custom-poison", "SKILL.md"), "utf8")).resolves.toContain(
				"version: 2.0.0",
			);
			expect(fixture.events).toHaveLength(1);
			await expect(readdir(join(fixture.home, "tmp"))).resolves.toEqual([]);
		},
	);
});
