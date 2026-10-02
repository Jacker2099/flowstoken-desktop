import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface BuildTask {
	name: string;
	inputs: string[];
	env: NodeJS.ProcessEnv;
}

interface BuildDefinition {
	tasks: BuildTask[];
	hashPaths(paths: string[], env: NodeJS.ProcessEnv): Promise<string>;
}

const fixtureRoots: string[] = [];

afterEach(async () => {
	for (const root of fixtureRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function loadBuildDefinition(): Promise<{ root: string; definition: BuildDefinition }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "vetta-build-inputs-")));
	fixtureRoots.push(root);
	const scriptDir = join(root, "apps", "desktop", "scripts");
	await mkdir(scriptDir, { recursive: true });
	for (const name of ["runtime-desktop", "runtime-node", "runtime-storage", "new-bundled-package", "ai"]) {
		const packageDir = join(root, "packages", name);
		await mkdir(join(packageDir, "dist"), { recursive: true });
		await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: `@vetta/${name}` }));
		await writeFile(join(packageDir, "dist", "index.js"), "export const version = 1;\n");
	}
	const source = await readFile(new URL("./build-dev-processes.mjs", import.meta.url), "utf8");
	// Evaluate the real task/hash definitions against a temporary workspace, without launching builds.
	const declarationOnly = source.replace(/await main\(\);\s*$/, "export { tasks, hashPaths };\n");
	expect(declarationOnly).not.toBe(source);
	const path = join(scriptDir, "build-dev-processes.mjs");
	await writeFile(path, declarationOnly);
	const definition: BuildDefinition = await import(pathToFileURL(path).href);
	return { root, definition };
}

describe("Desktop development process build inputs", () => {
	it("invalidates Main for every bundled workspace output, including newly added packages", async () => {
		const { root, definition } = await loadBuildDefinition();
		const main = definition.tasks.find((task) => task.name === "main");
		if (!main) throw new Error("Main build task is missing");
		for (const name of ["runtime-desktop", "runtime-node", "runtime-storage", "new-bundled-package"]) {
			const packageDir = join(root, "packages", name);
			expect(main.inputs).toContain(join(packageDir, "package.json"));
			expect(main.inputs).toContain(join(packageDir, "dist"));
			const before = await definition.hashPaths(main.inputs, main.env);
			await writeFile(join(packageDir, "dist", "index.js"), "export const version = 2;\n");
			expect(await definition.hashPaths(main.inputs, main.env)).not.toBe(before);
		}
		const beforeExternal = await definition.hashPaths(main.inputs, main.env);
		await writeFile(join(root, "packages", "ai", "dist", "index.js"), "export const version = 2;\n");
		expect(await definition.hashPaths(main.inputs, main.env)).toBe(beforeExternal);
	});
});
