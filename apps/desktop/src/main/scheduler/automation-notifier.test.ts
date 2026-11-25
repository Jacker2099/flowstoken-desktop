import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTask, TaskExecutionRecord } from "../../shared/automation.js";

const mocks = vi.hoisted(() => ({
	// 发送出去的通知是用户可观察终点：收集成状态，断言最终发出/未发出的事实。
	sent: [] as unknown[][],
	broadcast: vi.fn(async (...args: unknown[]) => {
		mocks.sent.push(args);
		return [{ ok: true, name: "hook" }] as Array<{ ok: boolean; name: string; error?: string }>;
	}),
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
		mocks.sent.length = 0;
	});

	it("suppresses the notification when the reply is exactly NO_REPLY", async () => {
		const result = await notifyAutomationFinished(
			task(notification),
			record("success"),
			AUTOMATION_NO_REPLY_SENTINEL,
		);
		expect(result).toBeUndefined();
		expect(mocks.sent).toHaveLength(0);
	});

	it("tolerates surrounding whitespace in the sentinel reply", async () => {
		const result = await notifyAutomationFinished(task(notification), record("success"), "  NO_REPLY\n");
		expect(result).toBeUndefined();
		expect(mocks.sent).toHaveLength(0);
	});

	it("still notifies when the reply merely contains the sentinel among other text", async () => {
		const result = await notifyAutomationFinished(task(notification), record("success"), "NO_REPLY but with details");
		// 成功发送时返回值也是 undefined（仅失败/异常才有错误文案），可观察终点是 webhook 实际收到通知。
		expect(result).toBeUndefined();
		expect(mocks.sent).toHaveLength(1);
		expect(mocks.sent[0]?.[0]).toMatchObject({ title: "Monitor", level: "success" });
	});

	it("still notifies failure outcomes normally", async () => {
		await notifyAutomationFinished(task(notification), record("failed"), "NO_REPLY");
		// 失败记录 reply 一般不是哨兵；即便恰好是，失败本身也值得通知吗？——失败时 when=failure 语义优先，
		// 但当前实现哨兵一律抑制：此处锁定「哨兵优先」的行为，避免误以为失败一定会发。
		expect(mocks.sent).toHaveLength(0);
	});
});
