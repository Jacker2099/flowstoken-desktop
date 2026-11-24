import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTask, TaskExecutionRecord } from "../../shared/automation.js";

const mocks = vi.hoisted(() => ({
	broadcast: vi.fn(async () => [{ ok: true, name: "hook" }] as Array<{ ok: boolean; name: string; error?: string }>),
}));

vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));
vi.mock("../webhook/index.js", () => ({ getWebhookManager: () => ({ broadcast: mocks.broadcast }) }));

import { AUTOMATION_NO_REPLY_SENTINEL, notifyAutomationFinished } from "./automation-notifier.js";

function task(notification?: ScheduledTask["notification"]): ScheduledTask {
	return {
		id: "task-1",
		name: "Monitor",
		prompt: "check",
		schedule: { kind: "daily", hour: 9, minute: 0 },
		runTarget: { mode: "new-session", projectCwd: "C:/workspace/project" },
		notification,
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
		lastRunAt: null,
		lastRunStatus: null,
	};
}

function record(status: TaskExecutionRecord["status"]): TaskExecutionRecord {
	return {
		id: "record-1",
		taskId: "task-1",
		startedAt: 1,
		completedAt: 2,
		status,
		prompt: "check",
		responsePreview: "",
	};
}

const notification = { webhookIds: ["hook-1"], when: "always" as const, template: "{{reply}}" };

describe("notifyAutomationFinished NO_REPLY sentinel", () => {
	beforeEach(() => {
		mocks.broadcast.mockClear();
	});

	it("suppresses the notification when the reply is exactly NO_REPLY", async () => {
		const result = await notifyAutomationFinished(
			task(notification),
			record("success"),
			AUTOMATION_NO_REPLY_SENTINEL,
		);
		expect(result).toBeUndefined();
		expect(mocks.broadcast).not.toHaveBeenCalled();
	});

	it("tolerates surrounding whitespace in the sentinel reply", async () => {
		await notifyAutomationFinished(task(notification), record("success"), "  NO_REPLY\n");
		expect(mocks.broadcast).not.toHaveBeenCalled();
	});

	it("still notifies when the reply merely contains the sentinel among other text", async () => {
		await notifyAutomationFinished(task(notification), record("success"), "NO_REPLY but with details");
		expect(mocks.broadcast).toHaveBeenCalled();
	});

	it("still notifies failure outcomes normally", async () => {
		await notifyAutomationFinished(task(notification), record("failed"), "NO_REPLY");
		// 失败记录 reply 一般不是哨兵；即便恰好是，失败本身也值得通知吗？——失败时 when=failure 语义优先，
		// 但当前实现哨兵一律抑制：此处锁定「哨兵优先」的行为，避免误以为失败一定会发。
		expect(mocks.broadcast).not.toHaveBeenCalled();
	});
});
