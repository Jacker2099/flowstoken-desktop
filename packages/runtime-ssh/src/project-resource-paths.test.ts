import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNodeResourceAccess } from "@vetta/runtime-node/host";
import { describe, expect, it } from "vitest";
import { createProjectResourceAccess } from "./project-resource-access.js";

describe("路径运算认得远程项目的 URI（不启动远端进程）", () => {
	const { paths } = createProjectResourceAccess(createNodeResourceAccess(), () => {
		throw new Error("Path operations must not open an SSH connection");
	});

	it("向上遍历停在远端根目录，不会穿进本机的祖先目录", () => {
		const visited: string[] = [];
		let current = paths.resolve("ssh://h1/srv/app/packages/web");
		for (;;) {
			visited.push(current);
			const parent = paths.dirname(current);
			if (parent === current) break;
			current = parent;
		}
		expect(visited).toEqual([
			"ssh://h1/srv/app/packages/web",
			"ssh://h1/srv/app/packages",
			"ssh://h1/srv/app",
			"ssh://h1/srv",
			"ssh://h1/",
		]);
	});

	it("由远程 cwd 拼出的路径仍然属于远端", () => {
		expect(paths.join("ssh://h1/srv/app", ".agents", "skills")).toBe("ssh://h1/srv/app/.agents/skills");
		expect(paths.resolve("ssh://h1/srv/app", "../lib/AGENTS.md")).toBe("ssh://h1/srv/lib/AGENTS.md");
		expect(paths.isAbsolute("ssh://h1/srv/app")).toBe(true);
		expect(paths.basename("ssh://h1/srv/app/AGENTS.md")).toBe("AGENTS.md");
		expect(paths.relative("ssh://h1/srv/app", "ssh://h1/srv/app/docs/a.md")).toBe("docs/a.md");
	});

	it("resolve 遇到后面的本机绝对路径时以它为准，与 path.resolve 同义", () => {
		const localAbsolute = resolve(tmpdir(), "skills");
		expect(paths.resolve("ssh://h1/srv/app", localAbsolute)).toBe(localAbsolute);
	});

	it("本机路径原样沿用本机语义", () => {
		expect(paths.join("/work", "app")).toBe(join("/work", "app"));
		expect(paths.isAbsolute("relative/path")).toBe(false);
	});
});
