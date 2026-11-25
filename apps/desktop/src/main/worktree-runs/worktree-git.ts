import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
/** diff 输出可能很大（并行实验经常重写整文件），放宽到 64MB。 */
const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitResult {
	readonly stdout: string;
	readonly stderr: string;
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

export const systemGitRunner: GitRunner = async (args, cwd) => {
	const { stdout, stderr } = await execFileAsync("git", [...args], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: MAX_BUFFER,
	});
	return { stdout: stdout.toString(), stderr: stderr.toString() };
};

/** 仓库校验与 base 解析：不是 git 仓库或无提交时直接拒绝——并行编排的 diff/补丁语义都建立在 base 提交上。 */
export async function resolveBaseCommit(projectPath: string, git: GitRunner): Promise<string> {
	try {
		await git(["rev-parse", "--is-inside-work-tree"], projectPath);
	} catch {
		throw new Error("所选项目不是 git 仓库，无法创建并行实验");
	}
	try {
		const head = await git(["rev-parse", "HEAD"], projectPath);
		return head.stdout.trim();
	} catch {
		throw new Error("仓库还没有任何提交，请先完成初始提交再创建并行实验");
	}
}

/** 建 worktree 并检出 base： lane 之间靠分支名隔离，分支名由调用方保证唯一。 */
export async function addWorktree(
	projectPath: string,
	worktreePath: string,
	branch: string,
	baseCommit: string,
	git: GitRunner,
): Promise<void> {
	await git(["worktree", "add", "-b", branch, worktreePath, baseCommit], projectPath);
}

export async function removeWorktree(
	projectPath: string,
	worktreePath: string,
	branch: string,
	git: GitRunner,
): Promise<void> {
	// lane 的 worktree/分支是编排器创建的资源，删除失败不阻断清理流程（可能已经手动删过）。
	await git(["worktree", "remove", "--force", worktreePath], projectPath).catch(() => undefined);
	await git(["branch", "-D", branch], projectPath).catch(() => undefined);
}

/** lane 工作区相对 base 的补丁：先 add -A 把未跟踪文件纳入索引，否则新文件不进 diff。 */
export async function laneDiff(worktreePath: string, baseCommit: string, git: GitRunner): Promise<string> {
	await git(["add", "-A"], worktreePath);
	const diff = await git(["diff", "--binary", "--full-index", "--no-color", baseCommit], worktreePath);
	return diff.stdout;
}

export async function laneDiffStat(worktreePath: string, baseCommit: string, git: GitRunner): Promise<string> {
	await git(["add", "-A"], worktreePath);
	const stat = await git(["diff", "--stat", baseCommit], worktreePath);
	return stat.stdout.trim();
}

/**
 * 把 lane 补丁应用到原项目工作区（不提交，成为未暂存改动）。
 * --3way 在上下文不完全匹配时退化到三路合并，提高补丁落上的概率；
 * 冲突时由 git 报错，调用方把错误透给用户——不动用户的 index/HEAD 是底线。
 */
export async function applyPatchToProject(projectPath: string, patch: string, git: GitRunner): Promise<void> {
	if (!patch.trim()) throw new Error("该 lane 相对起点没有任何改动");
	const dir = await mkdtemp(join(tmpdir(), "vetta-worktree-patch-"));
	try {
		const patchFile = join(dir, "lane.patch");
		await writeFile(patchFile, patch, "utf8");
		await git(["apply", "--3way", "--whitespace=nowarn", patchFile], projectPath);
	} catch (error) {
		const reason = error instanceof Error && "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
		if (reason.includes("conflict") || reason.includes("does not apply") || reason.includes("Failed to merge")) {
			throw new Error("补丁与原项目当前工作区冲突，未做任何改动；请先提交或还原本地改动后再采纳");
		}
		throw error;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** 列出 lane 相对 base 变更的文件清单（含状态字母），供 UI 文件级对比。 */
export async function laneChangedFiles(
	worktreePath: string,
	baseCommit: string,
	git: GitRunner,
): Promise<readonly { status: string; path: string }[]> {
	await git(["add", "-A"], worktreePath);
	const result = await git(["diff", "--name-status", baseCommit], worktreePath);
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [status = "", ...rest] = line.split("\t");
			return { status, path: rest.join("\t") };
		})
		.filter((entry) => entry.path.length > 0);
}
