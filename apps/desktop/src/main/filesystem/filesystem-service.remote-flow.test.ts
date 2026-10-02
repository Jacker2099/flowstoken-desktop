import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopbackSshConnection, createLoopbackTestScope, loopbackRemotePath } from "@vetta/ssh-transport/testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Observe the real cp boundary: NTFS cannot represent POSIX executable bits, but the
// client must still request preservation when its remote host writes the real bytes.
const commandDirectory = realpathSync(mkdtempSync(join(tmpdir(), "vetta-remote-copy-")));
writeFileSync(
	join(commandDirectory, "cp"),
	["#!/bin/sh", 'printf "%s\\n" "$@" > "$(dirname "$0")/copy-arguments"', 'exec /bin/cp "$@"', ""].join("\n"),
);
chmodSync(join(commandDirectory, "cp"), 0o755);
const connection = createLoopbackSshConnection("build-01", { commandDirectory });
vi.mock("../ssh/ssh-runtime.js", () => ({ getSshConnection: () => connection }));

const service = await import("./filesystem-service.js");
const directories: string[] = [];
const scopes: ReturnType<typeof createLoopbackTestScope>[] = [];
function ownedIt(
	name: string,
	body: (scope: ReturnType<typeof createLoopbackTestScope>) => Promise<void>,
	timeout?: number,
) {
	it(
		name,
		() => {
			const scope = createLoopbackTestScope();
			scope.onClosing(() => connection.abortOwnedOperations());
			scopes.push(scope);
			return scope.track(body(scope));
		},
		timeout,
	);
}
afterEach(async () => {
	for (const scope of scopes.splice(0)) await scope.close(() => connection.waitForIdle());
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
afterAll(async () => {
	await connection.waitForIdle();
	rmSync(commandDirectory, { recursive: true, force: true });
});

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

describe("远程项目的文件树：用户在面板里的一串常见操作", () => {
	let remoteRoot: string;
	let root: string;

	beforeEach(() => {
		remoteRoot = realpathSync(mkdtempSync(join(tmpdir(), "vetta-remote-tree-")));
		directories.push(remoteRoot);
		mkdirSync(join(remoteRoot, "src"));
		mkdirSync(join(remoteRoot, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(remoteRoot, "src/main.ts"), "export {};\n");
		writeFileSync(join(remoteRoot, "node_modules/pkg/index.js"), "");
		writeFileSync(join(remoteRoot, "logo.png"), PNG_1X1);
		writeFileSync(join(remoteRoot, "LICENSE"), "MIT\n");
		root = `ssh://build-01${loopbackRemotePath(remoteRoot)}`;
		service.allowProjectRoot(root);
	});

	ownedIt(
		"新建、改名、移动、删除都发生在远端",
		async (scope) => {
			const created = await scope.step(() => service.createFilesystemEntry(`${root}/src`, "notes.md", "file"));
			expect(created.path).toBe(`${root}/src/notes.md`);
			expect(existsSync(join(remoteRoot, "src/notes.md"))).toBe(true);
			await expect(
				scope.step(() => service.createFilesystemEntry(`${root}/src`, "notes.md", "file")),
			).rejects.toThrow(/EXISTS/);

			await scope.step(() => service.renameFilesystemPath(`${root}/src/notes.md`, `${root}/src/todo.md`));
			expect(existsSync(join(remoteRoot, "src/todo.md"))).toBe(true);

			await scope.step(() => service.createFilesystemEntry(root, "docs", "directory"));
			await scope.step(() => service.moveFilesystemPath(`${root}/src/todo.md`, `${root}/docs`));
			expect(existsSync(join(remoteRoot, "docs/todo.md"))).toBe(true);

			await scope.step(() => service.deleteFilesystemPath(`${root}/docs`));
			expect(existsSync(join(remoteRoot, "docs"))).toBe(false);
		},
		20_000,
	);

	ownedIt("无扩展名的文本、图片都能预览，呈现判断与本地项目同一套", async (scope) => {
		await expect(scope.step(() => service.readTextPreviewFile(`${root}/LICENSE`))).resolves.toMatchObject({
			status: "text",
			content: "MIT\n",
		});
		await expect(scope.step(() => service.readTextPreviewFile(`${root}/logo.png`))).resolves.toMatchObject({
			status: "binary",
		});
		await expect(scope.step(() => service.readFilesystemFile(`${root}/logo.png`))).resolves.toEqual({
			content: PNG_1X1.toString("base64"),
			encoding: "base64",
		});
		await expect(scope.step(() => service.readFilesystemBinaryFile(`${root}/logo.png`))).resolves.toMatchObject({
			mimeType: "image/png",
			size: PNG_1X1.byteLength,
		});
	});

	ownedIt("@ 选文件用的递归列举给出远端文件，跳过依赖目录", async (scope) => {
		const files = await scope.step(() => service.listFilesystemFilesRecursive(root));
		expect(files.map((file) => file.relPath).sort()).toEqual(["LICENSE", "logo.png", "src/main.ts"]);
		expect(files.find((file) => file.relPath === "src/main.ts")?.path).toBe(`${root}/src/main.ts`);
	});

	ownedIt("按文件名筛选的递归列举只给出命中的远端文件", async (scope) => {
		const files = await scope.step(() =>
			service.listFilesystemFilesRecursive(root, { names: ["LICENSE", "index.js"] }),
		);
		expect(files.map((file) => file.relPath)).toEqual(["LICENSE"]);
	});

	ownedIt("写文件保留远端文件原有的可执行位", async (scope) => {
		writeFileSync(join(remoteRoot, "run.sh"), "old");
		chmodSync(join(remoteRoot, "run.sh"), 0o755);
		await scope.step(() => service.writeFilesystemFile(`${root}/run.sh`, "new"));
		expect(readFileSync(join(remoteRoot, "run.sh"), "utf8")).toBe("new");
		const remoteFile = `${loopbackRemotePath(remoteRoot)}/run.sh`;
		expect(readFileSync(join(commandDirectory, "copy-arguments"), "utf8").trim().split("\n")).toEqual([
			"-p",
			"--",
			remoteFile,
			expect.stringContaining(`${remoteFile}.`),
		]);
		// POSIX hosts additionally prove the resulting filesystem mode. On Windows the
		// command boundary above proves -p was requested; do not pretend NTFS has 0755.
		if (process.platform !== "win32") expect(statSync(join(remoteRoot, "run.sh")).mode & 0o777).toBe(0o755);
	});

	ownedIt("插件文件能力用的授权检查认得远程路径：项目内放行，项目外拒绝", async (scope) => {
		await expect(
			scope.step(() => service.assertFilesystemRealPathWithinProject(`${root}/.git/MERGE_MSG`)),
		).resolves.toBeUndefined();
		await expect(
			scope.step(() => service.assertFilesystemRealPathWithinProject("ssh://build-01/etc/passwd")),
		).rejects.toThrow(/outside any known project/);
	});

	ownedIt("项目之外、靠 .. 绕出去、或项目根本身，一律不许动", async (scope) => {
		await expect(scope.step(() => service.deleteFilesystemPath(root))).rejects.toThrow(/project root/);
		await expect(scope.step(() => service.deleteFilesystemPath(`${root}/../outside`))).rejects.toThrow(
			/outside any known project/,
		);
		await expect(scope.step(() => service.readFilesystemFile("ssh://build-01/etc/passwd"))).rejects.toThrow(
			/outside any known project/,
		);
		expect(existsSync(remoteRoot)).toBe(true);
	});
});
