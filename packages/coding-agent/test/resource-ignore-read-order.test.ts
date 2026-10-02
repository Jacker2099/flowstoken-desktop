import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createNodeResourceAccess } from "@vetta/runtime-node/host";
import type ignore from "ignore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceAccessPort } from "../src/resources/contracts/resource-access.js";
import { collectAutoSkillEntries } from "../src/resources/packages/resource-discovery.js";
import { loadSkillsFromDir } from "../src/resources/skills/discovery.js";

const fault = vi.hoisted(() => ({ pattern: "", error: new Error("owned matcher fault") }));
vi.mock("ignore", async (importOriginal) => {
	const actual = await importOriginal<{ default: typeof ignore }>();
	return {
		...actual,
		default: (...args: Parameters<typeof ignore>) => {
			const matcher = actual.default(...args);
			const add = matcher.add.bind(matcher);
			matcher.add = (patterns) => {
				if (fault.pattern && Array.isArray(patterns) && patterns.includes(fault.pattern)) throw fault.error;
				return add(patterns);
			};
			return matcher;
		},
	};
});

const directories: string[] = [];
beforeEach(() => {
	fault.pattern = "";
});
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "ignore-read-order-"));
	directories.push(directory);
	const root = join(directory, "deploy");
	mkdirSync(root);
	writeFileSync(join(root, "SKILL.md"), "---\nname: deploy\ndescription: Owned skill.\n---\n\nContent.\n");
	writeFileSync(join(root, ".gitignore"), "*.md\n");
	writeFileSync(join(root, ".ignore"), "!SKILL.md\n");
	writeFileSync(join(root, ".fdignore"), "SKILL.md\n");
	return { root, access: createNodeResourceAccess() };
}

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const names = [".gitignore", ".ignore", ".fdignore"];
for (const loader of ["package", "skill"] as const) {
	describe(`${loader} ignore reads`, () => {
		const load = async (access: ResourceAccessPort, root: string) =>
			loader === "package"
				? collectAutoSkillEntries({ resourceAccess: access }, root)
				: (await loadSkillsFromDir({ resourceAccess: access, dir: root, source: "owned" })).skills.map(
						(skill) => skill.filePath,
					);

		it.each([true, false])(
			"bounded three reads finish out of order but preserve final precedence: %s",
			async (hide) => {
				const { root, access } = fixture();
				writeFileSync(join(root, ".fdignore"), hide ? "SKILL.md\n" : "");
				const gates = Object.fromEntries(names.map((name) => [name, deferred()]));
				const started: string[] = [];
				const completed: string[] = [];
				let active = 0;
				let maximum = 0;
				const reader: ResourceAccessPort = {
					...access,
					files: {
						...access.files,
						async readText(path, options) {
							const name = basename(path);
							if (!names.includes(name)) return access.files.readText(path, options);
							started.push(name);
							maximum = Math.max(maximum, ++active);
							try {
								await gates[name].promise;
								const content = await access.files.readText(path, options);
								completed.push(name);
								return content;
							} finally {
								active--;
							}
						},
					},
				};
				const pending = load(reader, root);
				try {
					await vi.waitFor(() => expect(new Set(started)).toEqual(new Set(names)));
					gates[".fdignore"].release();
					await vi.waitFor(() => expect(completed).toEqual([".fdignore"]));
					gates[".ignore"].release();
					await vi.waitFor(() => expect(completed).toEqual([".fdignore", ".ignore"]));
					gates[".gitignore"].release();
					expect(await pending).toEqual(hide ? [] : [join(root, "SKILL.md")]);
					expect(completed).toEqual([".fdignore", ".ignore", ".gitignore"]);
					expect(maximum).toBe(3);
					expect(active).toBe(0);
				} finally {
					for (const gate of Object.values(gates)) gate.release();
					await pending.catch(() => {});
				}
			},
		);

		it("preserves stat/read failures and does not read a non-file in skill discovery", async () => {
			const { root, access } = fixture();
			rmSync(join(root, ".ignore"));
			mkdirSync(join(root, ".ignore"));
			const reads: string[] = [];
			const reader: ResourceAccessPort = {
				...access,
				files: {
					...access.files,
					async stat(path, options) {
						if (basename(path) === ".gitignore") throw new Error("owned stat denied");
						return access.files.stat(path, options);
					},
					async readText(path, options) {
						reads.push(basename(path));
						if ([".gitignore", ".fdignore"].includes(basename(path))) throw new Error("owned read denied");
						return access.files.readText(path, options);
					},
				},
			};
			expect(await load(reader, root)).toEqual([join(root, "SKILL.md")]);
			if (loader === "skill") {
				expect(reads).not.toContain(".gitignore");
				expect(reads).not.toContain(".ignore");
			}
		});

		it("keeps the original matcher failure behavior", async () => {
			const { root, access } = fixture();
			writeFileSync(join(root, ".ignore"), "");
			writeFileSync(join(root, ".fdignore"), "");
			fault.pattern = "*.md";
			if (loader === "package") await expect(load(access, root)).rejects.toBe(fault.error);
			else expect(await load(access, root)).toEqual([join(root, "SKILL.md")]);
		});

		it("keeps path construction errors outside the recoverable file error boundary", async () => {
			const { root, access } = fixture();
			const error = new Error("owned path join failed");
			const reader: ResourceAccessPort = {
				...access,
				paths: {
					...access.paths,
					join: (...parts) => {
						if (parts.at(-1) === ".ignore") throw error;
						return access.paths.join(...parts);
					},
				},
			};
			await expect(load(reader, root)).rejects.toBe(error);
		});

		it("settles all pending reads and preserves the same abort reason", async () => {
			const { root, access } = fixture();
			const controller = new AbortController();
			const reason = new Error("owned abort");
			const gate = deferred();
			const started: string[] = [];
			let finished = 0;
			const reader: ResourceAccessPort = {
				...access,
				files: {
					...access.files,
					async readText(path, options) {
						if (!names.includes(basename(path))) return access.files.readText(path, options);
						started.push(basename(path));
						await gate.promise;
						finished++;
						options?.signal?.throwIfAborted();
						throw new Error("owned late read rejection");
					},
				},
			};
			const pending =
				loader === "package"
					? collectAutoSkillEntries({ resourceAccess: reader, signal: controller.signal }, root)
					: loadSkillsFromDir({ resourceAccess: reader, signal: controller.signal, dir: root, source: "owned" });
			try {
				await vi.waitFor(() => expect(started).toHaveLength(3));
				controller.abort(reason);
				gate.release();
				await expect(pending).rejects.toBe(reason);
				expect(finished).toBe(3);
			} finally {
				gate.release();
				await pending.catch(() => {});
			}
		});
	});
}
