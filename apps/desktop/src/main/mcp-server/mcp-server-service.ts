import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getDesktopConversationService } from "../conversations/desktop-conversation-service.js";
import { getDesktopProjectService } from "../projects/project-service-instance.js";
import { getSharedRuntime } from "../runtime.js";

export const MCP_SERVER_DEFAULT_PORT = 43118;
const PORT_ATTEMPTS = 20;

export interface McpServerStatus {
	readonly running: boolean;
	readonly port: number | null;
	readonly error?: string;
}

export interface McpServerServiceLogger {
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, error?: unknown): void;
}

interface JsonMsg {
	body: string;
	role: string;
}

function tokenMatches(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolveBody, rejectBody) => {
		let data = "";
		req.on("data", (chunk: Buffer) => {
			data += chunk.toString("utf8");
			if (data.length > 4 * 1024 * 1024) {
				rejectBody(new Error("request body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolveBody(data));
		req.on("error", rejectBody);
	});
}

function lastAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as JsonMsg & { content?: unknown };
		if (message?.role !== "assistant") continue;
		if (typeof message.body === "string" && message.body.trim()) return message.body;
		const content = message.content;
		if (typeof content === "string" && content.trim()) return content;
		if (Array.isArray(content)) {
			const text = content
				.map((part) =>
					part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
				)
				.filter(Boolean)
				.join("\n");
			if (text.trim()) return text;
		}
	}
	return "";
}

function simplifyMessages(messages: readonly unknown[], limit: number): readonly Record<string, unknown>[] {
	return messages.slice(-limit).map((message) => {
		const record = message as JsonMsg & { content?: unknown; timestamp?: number };
		return {
			role: record.role,
			text: typeof record.body === "string" ? record.body : typeof record.content === "string" ? record.content : "",
		};
	});
}

function jsonResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * 把桌面会话能力暴露为 MCP server（Streamable HTTP，仅 loopback + Bearer token）。
 *
 * 外部 Agent（Claude Code、自动化脚本等）由此驱动桌面会话：列项目/会话、
 * 建会话、发 prompt 并等待轮次完成、读消息。server 本身只做协议适配，
 * 会话语义全部归 desktop-conversation-service。
 */
export class DesktopMcpServerService {
	private server: Server | null = null;
	private port: number | null = null;
	private startError: string | undefined;

	constructor(
		private readonly dependencies: {
			readonly token: string;
			readonly logger: McpServerServiceLogger;
			readonly preferredPort?: number;
		},
	) {}

	status(): McpServerStatus {
		return { running: this.server !== null, port: this.port, error: this.startError };
	}

	private createMcpServer(): McpServer {
		const server = new McpServer({ name: "vetta-desktop", version: "1.0.0" });
		const conversations = getDesktopConversationService();
		const projects = getDesktopProjectService();

		server.registerTool(
			"list_projects",
			{
				title: "List projects",
				description: "List the projects registered in the Vetta desktop client.",
			},
			async () => {
				const snapshot = await projects.list();
				return jsonResult(snapshot.projects.map((project) => ({ path: project.path, name: project.name })));
			},
		);

		server.registerTool(
			"list_sessions",
			{
				title: "List sessions",
				description: "List sessions of a project. cwd defaults to every registered project.",
				inputSchema: { cwd: z.string().optional() },
			},
			async ({ cwd }) => {
				const cwds = cwd ? [cwd] : (await projects.list()).projects.map((project) => project.path);
				const output = [];
				for (const projectCwd of cwds) {
					const sessions = await conversations.listSessions(projectCwd);
					for (const session of sessions.slice(0, 50)) {
						output.push({
							cwd: projectCwd,
							sessionPath: session.path,
							name: session.name,
							modifiedAt: session.modifiedAt,
						});
					}
				}
				return jsonResult(output);
			},
		);

		server.registerTool(
			"create_session",
			{
				title: "Create session",
				description: "Create a new conversation session in a project and optionally send the first prompt.",
				inputSchema: {
					cwd: z.string(),
					prompt: z.string().optional(),
				},
			},
			async ({ cwd, prompt }) => {
				const session = await conversations.createSession({ cwd }, "conversation", "interactive");
				let reply: string | undefined;
				if (prompt?.trim()) {
					await conversations.promptInteractiveSession(session.sessionId, { text: prompt }, cwd);
					reply = lastAssistantText(getSharedRuntime().getMessages(session.sessionId));
				}
				return jsonResult({ sessionId: session.sessionId, sessionPath: session.sessionPath, reply });
			},
		);

		server.registerTool(
			"send_prompt",
			{
				title: "Send prompt",
				description:
					"Send a prompt to a session and wait for the turn to finish. The session is resumed from disk when needed.",
				inputSchema: {
					sessionPath: z.string(),
					text: z.string(),
				},
			},
			async ({ sessionPath, text }) => {
				const session = await conversations.openSession(sessionPath, undefined, "interactive");
				const outcome = await conversations.promptInteractiveSession(session.sessionId, { text });
				const reply = lastAssistantText(getSharedRuntime().getMessages(session.sessionId));
				return jsonResult({ status: outcome.status, reply });
			},
		);

		server.registerTool(
			"read_messages",
			{
				title: "Read messages",
				description: "Read the most recent messages of a session (the session is resumed read-only when needed).",
				inputSchema: {
					sessionPath: z.string(),
					limit: z.number().int().min(1).max(100).optional(),
				},
			},
			async ({ sessionPath, limit }) => {
				const session = await conversations.openSession(sessionPath, undefined, "interactive");
				return jsonResult(simplifyMessages(getSharedRuntime().getMessages(session.sessionId), limit ?? 20));
			},
		);

		return server;
	}

	async start(): Promise<McpServerStatus> {
		if (this.server) return this.status();
		const mcpServer = this.createMcpServer();
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
		await mcpServer.connect(transport);

		const token = this.dependencies.token;
		const httpServer = createServer((req, res) => {
			void this.handleRequest(req, res, transport, token);
		});

		const preferred = this.dependencies.preferredPort ?? MCP_SERVER_DEFAULT_PORT;
		const started = await this.listenWithFallback(httpServer, preferred);
		if (!started) {
			this.startError = `no free port in ${preferred}..${preferred + PORT_ATTEMPTS - 1}`;
			return this.status();
		}
		this.server = httpServer;
		this.port = started;
		this.startError = undefined;
		this.dependencies.logger.info("[mcp-server] listening", { port: started });
		return this.status();
	}

	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
		transport: StreamableHTTPServerTransport,
		token: string,
	): Promise<void> {
		try {
			const header = req.headers.authorization ?? "";
			const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
			if (!provided || !tokenMatches(provided, token)) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
			const body = req.method === "POST" ? await readBody(req) : undefined;
			await transport.handleRequest(req as never, res as never, body ? JSON.parse(body) : undefined);
		} catch (error) {
			this.dependencies.logger.warn("[mcp-server] request failed", error);
			if (!res.headersSent) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "bad request" }));
			} else if (!res.writableEnded) {
				res.end();
			}
		}
	}

	private listenWithFallback(server: Server, startPort: number): Promise<number | null> {
		return new Promise((resolveListen) => {
			let attempt = 0;
			const tryPort = (): void => {
				const port = startPort + attempt;
				const onError = (error: NodeJS.ErrnoException): void => {
					if (error.code === "EADDRINUSE" && attempt < PORT_ATTEMPTS - 1) {
						attempt += 1;
						tryPort();
					} else {
						resolveListen(null);
					}
				};
				server.once("error", onError);
				server.listen(port, "127.0.0.1", () => {
					server.removeListener("error", onError);
					resolveListen(port);
				});
			};
			tryPort();
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		this.port = null;
		if (!server) return;
		// close() 只等新连接停止后空闲连接自然耗尽；keep-alive socket 会拖住热重启，
		// 也会让复用连接池的客户端拿到半关闭 socket（ECONNRESET），这里强制清空。
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
}
