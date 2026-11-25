import { randomBytes } from "node:crypto";
import { readDesktopConfig, updateDesktopConfig } from "../config/desktop-config-store.js";
import { getAppLogger } from "../logger.js";
import { DesktopMcpServerService, type McpServerStatus } from "./mcp-server-service.js";

const log = getAppLogger("mcp-server");

let service: DesktopMcpServerService | null = null;
let activeToken: string | null = null;
let syncing = false;
let pendingSync = false;

/**
 * 按当前配置对齐 MCP server 的实际状态：该开开、该关关、换 token/端口就重启。
 *
 * 并发收口：sync 期间到来的调用只补一次尾随和跑，不给同一端口叠两个 server。
 * token 首次开启时自动生成并写回配置——token 是接入凭证，必须持久化，
 * 否则每次重启应用外部客户端都要重新配置。
 */
export async function syncDesktopMcpServer(): Promise<McpServerStatus> {
	if (syncing) {
		pendingSync = true;
		return service?.status() ?? { running: false, port: null };
	}
	syncing = true;
	try {
		const config = await readDesktopConfig();
		const mcpConfig = config.mcpServer ?? {};
		if (!mcpConfig.enabled) {
			if (service) {
				await service.stop();
				service = null;
				activeToken = null;
				log.info("[mcp-server] stopped");
			}
			return { running: false, port: null };
		}

		let token = mcpConfig.token;
		if (!token) {
			token = randomBytes(24).toString("base64url");
			await updateDesktopConfig((current) => ({
				...current,
				mcpServer: { ...current.mcpServer, enabled: true, token },
			}));
			log.info("[mcp-server] generated access token");
		}

		if (service && activeToken !== token) {
			await service.stop();
			service = null;
			activeToken = null;
		}
		if (!service) {
			service = new DesktopMcpServerService({ token, logger: log, preferredPort: mcpConfig.port });
			activeToken = token;
		}
		return await service.start();
	} finally {
		syncing = false;
		if (pendingSync) {
			pendingSync = false;
			void syncDesktopMcpServer();
		}
	}
}

export async function stopDesktopMcpServer(): Promise<void> {
	if (!service) return;
	await service.stop();
	service = null;
	activeToken = null;
}

export function getDesktopMcpServerStatus(): McpServerStatus {
	return service?.status() ?? { running: false, port: null };
}
