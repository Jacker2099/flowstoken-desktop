import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeResourceAccess } from "@vetta/runtime-node/host";
import { createLoopbackSshConnection } from "@vetta/ssh-transport/testing";
import { describe, expect, it } from "vitest";
import { createProjectResourceAccess } from "./project-resource-access.js";

function createAccess() {
	const connection = createLoopbackSshConnection();
	const requestedHosts: string[] = [];
	const access = createProjectResourceAccess(createNodeResourceAccess(), (hostId) => {
		requestedHosts.push(hostId);
		return connection;
	});
	return { access, requestedHosts };
}

describe("文件读取按路径归属分发（远端经回环 SSH）", () => {
	function createRemoteProject(): string {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "vetta-remote-resources-")));
		mkdirSync(join(root, ".agents/skills/deploy"), { recursive: true });
		writeFileSync(join(root, "AGENTS.md"), "# 远端项目规则\n");
		writeFileSync(join(root, ".agents/skills/deploy/SKILL.md"), "---\nname: deploy\n---\n");
		symlinkSync(join(root, "AGENTS.md"), join(root, "CLAUDE.md"));
		return root;
	}

	it("读到远端项目自己的 AGENTS.md 与技能目录", async () => {
		const root = createRemoteProject();
		const { access, requestedHosts } = createAccess();
		const uri = `ssh://build-01${root}`;

		await expect(access.files.readText(`${uri}/AGENTS.md`)).resolves.toBe("# 远端项目规则\n");
		await expect(access.files.stat(`${uri}/AGENTS.md`)).resolves.toMatchObject({ kind: "file" });
		await expect(access.files.stat(`${uri}/missing.md`)).resolves.toBeUndefined();
		const entries = await access.files.readDirectory(`${uri}/.agents/skills`);
		expect(entries).toEqual([{ name: "deploy", kind: "directory", symbolicLink: false }]);
		expect(new Set(requestedHosts)).toEqual(new Set(["build-01"]));
	});

	it("符号链接按它指向的内容回答，真实路径仍带着主机归属", async () => {
		const root = createRemoteProject();
		const { access } = createAccess();
		const uri = `ssh://build-01${root}`;

		await expect(access.files.stat(`${uri}/CLAUDE.md`)).resolves.toMatchObject({ kind: "file" });
		await expect(access.files.realPath(`${uri}/CLAUDE.md`)).resolves.toBe(`${uri}/AGENTS.md`);
	});

	it("本机路径不经过 SSH", async () => {
		const root = createRemoteProject();
		const { access, requestedHosts } = createAccess();

		await expect(access.files.readText(join(root, "AGENTS.md"))).resolves.toBe("# 远端项目规则\n");
		expect(requestedHosts).toEqual([]);
	});
});
