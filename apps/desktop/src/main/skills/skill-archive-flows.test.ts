import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
	expect(getSkillBaseDir("skill")).toBe(join(fixture.home, "skills"));
	expect(getSkillBaseDir("scene")).toBe(join(fixture.home, "scene"));
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
			const { installSkillFromMarketArchive } = await import("./skill-market-install.js");
			await installSkillFromMarketArchive("linked-skill", "skill", await readFile(archivePath));
			const destination = join(fixture.home, "skills", "linked-skill");
			expect((await lstat(join(destination, "tool-link"))).isSymbolicLink()).toBe(true);
			await expect(readlink(join(destination, "tool-link"))).resolves.toBe("bin/tool");
			await expect(readFile(join(destination, "tool-link"), "utf8")).resolves.toBe("linked-script");
			expect((await lstat(join(destination, "bin", "tool"))).mode & 0o111).not.toBe(0);
			await expect(readdir(join(fixture.home, "tmp"))).resolves.toEqual([]);
		},
	);

	it.each(["skill", "scene"] as const)(
		"installs and updates a market %s while preserving overlay files",
		async (type) => {
			const { installSkillFromMarketArchive } = await import("./skill-market-install.js");
			const initial = await archiveOf({ "SKILL.md": skillMarkdown("market-demo", "1.2.3", type) });
			await expect(
				installSkillFromMarketArchive("market-demo", type, initial, {
					sha256: createHash("sha256").update(initial).digest("hex"),
				}),
			).resolves.toEqual({ name: "market-demo", type, version: "1.2.3", updated: false });
			const destination = join(fixture.home, type === "scene" ? "scene" : "skills", "market-demo");
			await writeFile(join(destination, "legacy.txt"), "keep-existing-overlay", "utf8");
			const updated = await archiveOf({ "SKILL.md": skillMarkdown("market-demo", "2.3.4", type), "new.txt": "new" });
			await expect(
				installSkillFromMarketArchive("market-demo", type, updated, {
					alias: "Demo",
					marketDescription: "Public description",
				}),
			).resolves.toEqual({ name: "market-demo", type, version: "2.3.4", updated: true });
			await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toContain("version: 2.3.4");
			await expect(readFile(join(destination, "legacy.txt"), "utf8")).resolves.toBe("keep-existing-overlay");
			await expect(readFile(join(destination, "new.txt"), "utf8")).resolves.toBe("new");
			const state = await installedState();
			expect(JSON.parse(state.manifest) as unknown).toMatchObject({
				"market-demo": {
					type,
					source: "market",
					version: "2.3.4",
					enabled: true,
					alias: "Demo",
					marketDescription: "Public description",
				},
			});
			expect(JSON.parse(state.ledger) as unknown).toMatchObject({
				entries: { [`${type}:market-demo`]: { version: "2.3.4" } },
			});
			expect(fixture.events).toEqual([
				{
					type: "resource.lifecycle",
					resourceKind: type,
					operation: "installed",
					resourceId: "market-demo",
					source: "market",
				},
				{
					type: "resource.lifecycle",
					resourceKind: type,
					operation: "updated",
					resourceId: "market-demo",
					source: "market",
				},
			]);
			await expect(readdir(join(fixture.home, "tmp"))).resolves.toEqual([]);
		},
	);

	it("does not publish partial members from a truncated market TGZ or change the prior manifest/events", async () => {
		const { installSkillFromMarketArchive } = await import("./skill-market-install.js");
		const initial = await archiveOf({ "SKILL.md": skillMarkdown("market-demo", "1.0.0") });
		await installSkillFromMarketArchive("market-demo", "skill", initial);
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

		await expect(installSkillFromMarketArchive("market-demo", "skill", truncated)).rejects.toThrow();
		await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toContain("version: 1.0.0");
		expect(await installedState()).toEqual(prior);
		expect(fixture.events).toHaveLength(1);
		await expect(readdir(join(fixture.home, "tmp"))).resolves.toEqual([]);
	});

	it.each(["tgz", "zip"] as const)(
		"imports a custom scene through the registered IPC using real %s, then rejects a duplicate",
		async (format) => {
			const buffer = await archiveOf(
				{ "package/SKILL.md": skillMarkdown("custom-scene", "3.4.5", "scene"), "package/data.txt": "custom-data" },
				format,
			);
			await expect(importArchive(buffer)).resolves.toEqual({ name: "custom-scene", type: "scene" });
			const destination = join(fixture.home, "scene", "custom-scene");
			await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toContain(
				'description: "Contains: a colon"',
			);
			await expect(readFile(join(destination, "data.txt"), "utf8")).resolves.toBe("custom-data");
			const prior = await installedState();
			expect(JSON.parse(prior.manifest) as unknown).toMatchObject({
				"custom-scene": {
					source: "custom",
					type: "scene",
					version: "3.4.5",
					enabled: true,
					description: "Contains: a colon",
				},
			});
			expect(JSON.parse(prior.ledger) as unknown).toMatchObject({
				entries: { "scene:custom-scene": { version: "3.4.5" } },
			});
			expect(fixture.events).toEqual([
				{
					type: "resource.lifecycle",
					resourceKind: "scene",
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
		"market and custom TGZ imports use the system tool despite a real PATH tar poison",
		async () => {
			const market = await archiveOf({ "SKILL.md": skillMarkdown("market-poison", "1.0.0") });
			const custom = await archiveOf({ "SKILL.md": skillMarkdown("custom-poison", "2.0.0") });
			const poisonDirectory = join(testRoot, "path poison");
			await mkdir(poisonDirectory);
			await copyFile(process.execPath, join(poisonDirectory, "tar.exe"));
			const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
			vi.stubEnv(pathKey, `${poisonDirectory}${delimiter}${process.env[pathKey] ?? ""}`);
			const unsafe = spawnSync("tar", ["--version"], { encoding: "utf8" });
			expect(unsafe.status, unsafe.stderr).toBe(0);
			expect(unsafe.stdout.trim()).toBe(process.version);
			const { installSkillFromMarketArchive } = await import("./skill-market-install.js");
			await expect(installSkillFromMarketArchive("market-poison", "skill", market)).resolves.toMatchObject({
				name: "market-poison",
			});
			await expect(importArchive(custom)).resolves.toEqual({ name: "custom-poison", type: "skill" });
			await expect(readFile(join(fixture.home, "skills", "market-poison", "SKILL.md"), "utf8")).resolves.toContain(
				"version: 1.0.0",
			);
			await expect(readFile(join(fixture.home, "skills", "custom-poison", "SKILL.md"), "utf8")).resolves.toContain(
				"version: 2.0.0",
			);
			expect(fixture.events).toHaveLength(2);
			await expect(readdir(join(fixture.home, "tmp"))).resolves.toEqual([]);
		},
	);
});
