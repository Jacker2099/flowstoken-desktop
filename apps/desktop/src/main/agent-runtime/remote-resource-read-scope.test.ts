import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeResourceAccess, type NodeResourceAccess } from "@vetta/runtime-node/host";
import { isSshProjectUri, parseProjectLocation } from "@vetta/ssh-transport";
import { afterEach, expect, it } from "vitest";
import { createRemoteResourceReadScope } from "./remote-resource-read-scope.js";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "remote-resource-scope-"));
	directories.push(directory);
	const agents = "ssh://owned/AGENTS.md";
	const skill = "ssh://owned/skills/SKILL.md";
	mkdirSync(join(directory, "skills"));
	writeFileSync(join(directory, "AGENTS.md"), "old agents");
	writeFileSync(join(directory, "skills/SKILL.md"), "old skill");
	const native = createNodeResourceAccess();
	const pathOnOwnedFs = (path: string): string => {
		if (!isSshProjectUri(path)) return path;
		const location = parseProjectLocation(path);
		if (location.kind !== "ssh") throw new Error("Expected owned resource URI");
		return join(directory, location.remotePath.slice(1));
	};
	const calls = { stat: 0, readText: 0, readDirectory: 0, realPath: 0 };
	// Test the scope against real native files. This URI mapping is an external file port,
	// not an SSH/process simulation; the loopback integration test covers that boundary.
	const access: NodeResourceAccess = {
		paths: native.paths,
		files: {
			stat: (path, options) => {
				calls.stat++;
				return native.files.stat(pathOnOwnedFs(path), options);
			},
			readText: (path, options) => {
				calls.readText++;
				return native.files.readText(pathOnOwnedFs(path), options);
			},
			readDirectory: (path, options) => {
				calls.readDirectory++;
				return native.files.readDirectory(pathOnOwnedFs(path), options);
			},
			realPath: (path, options) => {
				calls.realPath++;
				return native.files.realPath(pathOnOwnedFs(path), options);
			},
		},
	};
	return { directory, agents, skill, calls, access, scope: createRemoteResourceReadScope(access) };
}

it("singleflights repeated remote metadata/content reads while preserving actual native file values", async () => {
	const { scope, agents, calls } = fixture();
	await scope.run(async () => {
		const contents = await Promise.all([scope.access.files.readText(agents), scope.access.files.readText(agents)]);
		expect(contents).toEqual(["old agents", "old agents"]);
		const entries = await Promise.all([scope.access.files.stat(agents), scope.access.files.stat(agents)]);
		expect(entries.map((entry) => entry?.kind)).toEqual(["file", "file"]);
		expect(await scope.access.files.realPath(agents)).toBe(await scope.access.files.realPath(agents));
	});
	expect(calls).toEqual({ stat: 1, readText: 1, readDirectory: 0, realPath: 1 });
});

it("isolates concurrent reloads and observes changed AGENTS and SKILL content in the next reload", async () => {
	const { scope, agents, skill, directory, calls } = fixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let ready!: () => void;
	const entered = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const first = scope.run(async () => {
		expect(await Promise.all([scope.access.files.readText(agents), scope.access.files.readText(skill)])).toEqual([
			"old agents",
			"old skill",
		]);
		ready();
		await gate;
		return Promise.all([scope.access.files.readText(agents), scope.access.files.readText(skill)]);
	});
	await entered;
	writeFileSync(join(directory, "AGENTS.md"), "new agents");
	writeFileSync(join(directory, "skills/SKILL.md"), "new skill");
	expect(
		await scope.run(() => Promise.all([scope.access.files.readText(agents), scope.access.files.readText(skill)])),
	).toEqual(["new agents", "new skill"]);
	release();
	expect(await first).toEqual(["old agents", "old skill"]);
	expect(calls.readText).toBe(4);
});

it("does not keep missing content or an operation error cached and clears failed reload scopes", async () => {
	const { scope, directory, calls } = fixture();
	const missing = "ssh://owned/new.md";
	await scope.run(async () => {
		await expect(scope.access.files.readText(missing)).rejects.toMatchObject({ code: "ENOENT" });
		writeFileSync(join(directory, "new.md"), "created");
		expect(await scope.access.files.readText(missing)).toBe("created");
	});
	const failure = new Error("reload failed");
	await expect(
		scope.run(async () => {
			await scope.access.files.readText(missing);
			throw failure;
		}),
	).rejects.toBe(failure);
	writeFileSync(join(directory, "new.md"), "updated");
	expect(await scope.run(() => scope.access.files.readText(missing))).toBe("updated");
	expect(calls.readText).toBe(4);
});

it("passes local paths, directory queries and signalled reads through without sharing or suppressing abort", async () => {
	const { scope, agents, directory, calls } = fixture();
	await scope.run(async () => {
		await scope.access.files.readText(agents);
		await scope.access.files.readText(agents);
		const signal = new AbortController().signal;
		await scope.access.files.readText(agents, { signal });
		await scope.access.files.readText(agents, { signal });
		await expect(scope.access.files.readText(agents, { signal: AbortSignal.abort() })).rejects.toMatchObject({
			name: "AbortError",
		});
		await scope.access.files.readText(join(directory, "AGENTS.md"));
		await scope.access.files.readText(join(directory, "AGENTS.md"));
		await scope.access.files.readDirectory("ssh://owned/");
		await scope.access.files.readDirectory("ssh://owned/");
	});
	expect(calls.readText).toBe(6);
	expect(calls.readDirectory).toBe(2);
});

it("deactivates an inherited async scope after completion so late work and subsequent reloads read fresh", async () => {
	const { scope, agents, directory, calls } = fixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let late!: Promise<string>;
	await scope.run(async () => {
		expect(await scope.access.files.readText(agents)).toBe("old agents");
		late = gate.then(() => scope.access.files.readText(agents));
	});
	writeFileSync(join(directory, "AGENTS.md"), "late update");
	release();
	expect(await late).toBe("late update");
	expect(await scope.run(() => scope.access.files.readText(agents))).toBe("late update");
	expect(calls.readText).toBe(3);
});

it("preserves the original file port receiver for an uncached directory method", async () => {
	const { access, agents } = fixture();
	const original = access.files.readDirectory;
	const files = {
		...access.files,
		readDirectory(path: string) {
			expect(this).toBe(files);
			return original(path);
		},
	};
	const scope = createRemoteResourceReadScope({ ...access, files });
	await scope.run(async () => {
		expect((await scope.access.files.readDirectory("ssh://owned/")).map((entry) => entry.name)).toContain(
			"AGENTS.md",
		);
		expect(await scope.access.files.readText(agents)).toBe("old agents");
	});
});

it("a late rejection from a finished scope cannot evict the same key in another active reload", async () => {
	const { access, agents } = fixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const failure = new Error("owned read failed");
	const scope = createRemoteResourceReadScope({
		...access,
		files: {
			...access.files,
			async readText(path, options) {
				if (++calls === 1) {
					await gate;
					throw failure;
				}
				return access.files.readText(path, options);
			},
		},
	});
	let late!: Promise<string>;
	await scope.run(async () => {
		late = scope.access.files.readText(agents);
	});
	await scope.run(async () => {
		expect(await scope.access.files.readText(agents)).toBe("old agents");
		release();
		await expect(late).rejects.toBe(failure);
		expect(await scope.access.files.readText(agents)).toBe("old agents");
	});
	expect(calls).toBe(2);
});

it("nested success and failure keep the outer snapshot active, and a later run re-enables a fresh context", async () => {
	const { scope, agents, directory, calls } = fixture();
	await scope.run(async () => {
		expect(await scope.access.files.readText(agents)).toBe("old agents");
		writeFileSync(join(directory, "AGENTS.md"), "nested update");
		expect(await scope.run(() => scope.access.files.readText(agents))).toBe("nested update");
		const error = new Error("nested failure");
		await expect(
			scope.run(async () => {
				expect(await scope.access.files.readText(agents)).toBe("nested update");
				throw error;
			}),
		).rejects.toBe(error);
		expect(await scope.access.files.readText(agents)).toBe("old agents");
	});
	expect(await scope.run(() => scope.access.files.readText(agents))).toBe("nested update");
	expect(calls.readText).toBe(4);
});
