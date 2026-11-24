import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	desktopConfig: { experimental: { memory: false }, defaultAgentMode: "work" as const },
}));

vi.mock("../ipc/fs.js", () => ({
	allowProjectRoot: vi.fn(),
	readDesktopConfig: vi.fn(async () => mocks.desktopConfig),
}));
vi.mock("./session-paths.js", () => ({
	ensureConversationSubCwd: vi.fn(async () => undefined),
	ensureSessionWorkingCwd: vi.fn(async () => {}),
	readSessionCwdFromHeader: vi.fn(async () => undefined),
	resolveSessionDirForCwd: vi.fn(() => undefined),
}));
vi.mock("./session-agent-mode-store.js", () => ({
	LEGACY_SESSION_AGENT_MODE: "work",
	readSessionAgentMode: vi.fn(async () => undefined),
}));

import { resolveDesktopSessionConfig } from "./resolve-session-config.js";

interface MemorySelectionShape {
	sessionConfiguration?: { memoryMode?: boolean; memoryFile?: string };
}

function selectionOf(config: { agent?: unknown }): MemorySelectionShape {
	return (config.agent ?? {}) as MemorySelectionShape;
}

describe("resolveDesktopSessionConfig memory injection", () => {
	beforeEach(() => {
		mocks.desktopConfig = { experimental: { memory: false }, defaultAgentMode: "work" };
	});

	it("leaves memory disabled by default", async () => {
		const resolved = await resolveDesktopSessionConfig({ cwd: "C:/workspace/alpha" }, "conversation", "interactive");
		const selection = selectionOf(resolved.config);
		expect(selection.sessionConfiguration?.memoryMode).toBe(false);
		expect(selection.sessionConfiguration?.memoryFile).toBeUndefined();
	});

	it("enables memory mode with a project-keyed file inside the agent state dir when opted in", async () => {
		mocks.desktopConfig = { experimental: { memory: true }, defaultAgentMode: "work" };
		const resolved = await resolveDesktopSessionConfig({ cwd: "C:/workspace/alpha" }, "conversation", "interactive");
		const selection = selectionOf(resolved.config);
		expect(selection.sessionConfiguration?.memoryMode).toBe(true);
		const file = selection.sessionConfiguration?.memoryFile ?? "";
		expect(file).toContain("memory");
		expect(file.endsWith("MEMORY.md")).toBe(true);
		// 不落在用户工程目录里。
		expect(file.startsWith("C:/workspace/alpha")).toBe(false);
	});

	it("shares one memory file across sessions of the same project but separates different projects", async () => {
		mocks.desktopConfig = { experimental: { memory: true }, defaultAgentMode: "work" };
		const a1 = await resolveDesktopSessionConfig({ cwd: "C:/workspace/alpha" }, "conversation", "interactive");
		const a2 = await resolveDesktopSessionConfig({ cwd: "C:/workspace/alpha" }, "conversation", "interactive");
		const b = await resolveDesktopSessionConfig({ cwd: "C:/workspace/beta" }, "conversation", "interactive");
		const fa = selectionOf(a1.config).sessionConfiguration?.memoryFile;
		expect(selectionOf(a2.config).sessionConfiguration?.memoryFile).toBe(fa);
		expect(selectionOf(b.config).sessionConfiguration?.memoryFile).not.toBe(fa);
	});
});
