import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listSessions: vi.fn(async () => [
		{ id: "s1", path: "/tmp/sess/s1.jsonl", cwd: "/work/a", firstMessage: "hi", modifiedAt: 1, name: "demo" },
	]),
	createSession: vi.fn(async () => ({ sessionId: "new-session", sessionPath: "/tmp/sess/new.jsonl" })),
	// 会话 id 从路径派生：最终响应能拿到回复，当且仅当 sessionPath/sessionId 沿链正确传递。
	openSession: vi.fn(async (sessionPath: string) => ({
		sessionId: `derived:${sessionPath}`,
		sessionPath,
	})),
	promptInteractiveSession: vi.fn(async (sessionId: string, input: { text: string }) => {
		mocks.getMessages.mockImplementation((id: string): { role: string; body: string }[] =>
			id === sessionId
				? [
						{ role: "user", body: input.text },
						{ role: "assistant", body: `reply-to:${input.text}` },
					]
				: [],
		);
		return { status: "completed" };
	}),
	listProjects: vi.fn(async () => ({ projects: [{ path: "/work/a", name: "a" }] })),
	getMessages: vi.fn((_id: string): { role: string; body: string }[] => []),
}));

vi.mock("../conversations/desktop-conversation-service.js", () => ({
	getDesktopConversationService: () => ({
		listSessions: mocks.listSessions,
		createSession: mocks.createSession,
		openSession: mocks.openSession,
		promptInteractiveSession: mocks.promptInteractiveSession,
	}),
}));
vi.mock("../projects/project-service-instance.js", () => ({
	getDesktopProjectService: () => ({ list: mocks.listProjects }),
}));
vi.mock("../runtime.js", () => ({
	getSharedRuntime: () => ({ getMessages: mocks.getMessages }),
}));

import { DesktopMcpServerService } from "./mcp-server-service.js";

const TOKEN = "test-token-0123456789abcdef";
const logger = { info: vi.fn(), warn: vi.fn() };

async function rpc(
	port: number,
	body: unknown,
	token?: string,
	sessionId?: string,
): Promise<{ status: number; text: string; sessionId: string | null }> {
	const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(sessionId ? { "mcp-session-id": sessionId } : {}),
		},
		body: JSON.stringify(body),
	});
	return { status: response.status, text: await response.text(), sessionId: response.headers.get("mcp-session-id") };
}

/** 真实客户端流程：initialize 握手拿 session id，再发 initialized 通知。 */
async function initializeSession(port: number, token: string): Promise<string> {
	const init = await rpc(
		port,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
		},
		token,
	);
	const sessionId = init.sessionId;
	if (!sessionId) throw new Error(`initialize failed: ${init.status} ${init.text}`);
	await rpc(port, { jsonrpc: "2.0", method: "notifications/initialized" }, token, sessionId);
	return sessionId;
}

describe("DesktopMcpServerService", () => {
	let service: DesktopMcpServerService;
	// 每个测试独立端口：node fetch 的连接池按 host:port 复用 keep-alive socket，
	// 同一端口换 server 后首个请求可能落到已被销毁的 socket 上（ECONNRESET）。
	let portBase = 44200;

	beforeEach(() => {
		vi.clearAllMocks();
		portBase += 10;
		service = new DesktopMcpServerService({ token: TOKEN, logger, preferredPort: portBase });
	});

	it("rejects requests without a valid bearer token and accepts the correct one", async () => {
		const started = await service.start();
		try {
			expect(started.running).toBe(true);
			const port = started.port as number;
			const denied = await rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
			expect(denied.status).toBe(401);

			const allowed = await rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, TOKEN);
			expect(allowed.status).not.toBe(401);
		} finally {
			await service.stop();
		}
	});

	it("lists tools covering projects, sessions, prompt and messages", async () => {
		const started = await service.start();
		try {
			const port = started.port as number;
			const sessionId = await initializeSession(port, TOKEN);
			const response = await rpc(
				port,
				{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
				TOKEN,
				sessionId,
			);
			for (const name of ["list_projects", "list_sessions", "create_session", "send_prompt", "read_messages"]) {
				expect(response.text).toContain(name);
			}
		} finally {
			await service.stop();
		}
	});

	it("send_prompt resumes the session and returns the assistant reply", async () => {
		const started = await service.start();
		try {
			const port = started.port as number;
			const sessionId = await initializeSession(port, TOKEN);
			const response = await rpc(
				port,
				{
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: { name: "send_prompt", arguments: { sessionPath: "/tmp/sess/s1.jsonl", text: "hello" } },
				},
				TOKEN,
				sessionId,
			);
			// 回复文本由 prompt 输入派生：只有 sessionPath→sessionId→prompt→消息读取全链正确才会出现。
			expect(response.text).toContain("reply-to:hello");
		} finally {
			await service.stop();
		}
	});

	it("reports stopped status before start and after stop", async () => {
		expect(service.status().running).toBe(false);
		await service.start();
		expect(service.status().running).toBe(true);
		expect(service.status().port).toBe(portBase);
		await service.stop();
		expect(service.status().running).toBe(false);
	});
});
