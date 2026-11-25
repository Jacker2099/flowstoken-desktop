import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	fromId: vi.fn(),
	// 到达 electron 的截图参数是服务的输出契约：收集成状态，断言最终事实。
	captureArgs: [] as unknown[],
	captureResult: null as unknown,
	capturePage: vi.fn((args: unknown) => {
		mocks.captureArgs.push(args);
		return Promise.resolve(mocks.captureResult);
	}),
	writeFile: vi.fn(async () => {}),
	mkdir: vi.fn(async () => {}),
}));

vi.mock("electron", () => ({
	webContents: { fromId: mocks.fromId },
}));
vi.mock("node:fs/promises", () => ({
	mkdir: mocks.mkdir,
	writeFile: mocks.writeFile,
}));

import { captureElementScreenshot } from "./element-capture-service.js";

function guest(overrides: Record<string, unknown> = {}) {
	return {
		isDestroyed: () => false,
		getType: () => "webview",
		capturePage: mocks.capturePage,
		...overrides,
	};
}

const rect = { x: 10, y: 20, width: 300, height: 200 };

describe("captureElementScreenshot", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.captureArgs.length = 0;
		mocks.captureResult = {
			isEmpty: () => false,
			toPNG: () => Buffer.from("png"),
			getSize: () => ({ width: 600, height: 400 }),
		};
		mocks.fromId.mockReturnValue(guest());
	});

	it("captures the element rect of a webview guest and persists a png", async () => {
		const result = await captureElementScreenshot(7, rect);
		expect(mocks.captureArgs).toEqual([{ x: 10, y: 20, width: 300, height: 200 }]);
		expect(result.width).toBe(600);
		expect(result.path).toContain("element-");
		expect(result.path).toMatch(/element-.*\.png$/);
	});

	it("rejects non-webview webContents so arbitrary windows cannot be captured", async () => {
		mocks.fromId.mockReturnValue(guest({ getType: () => "window" }));
		await expect(captureElementScreenshot(7, rect)).rejects.toThrow("embedded browser");
	});

	it("rejects invalid ids and rects", async () => {
		await expect(captureElementScreenshot(-1, rect)).rejects.toThrow("invalid webContentsId");
		await expect(captureElementScreenshot(7, { ...rect, width: 0 })).rejects.toThrow("invalid capture rect");
		await expect(captureElementScreenshot(7, { ...rect, height: 99999 })).rejects.toThrow("invalid capture rect");
		await expect(captureElementScreenshot(7, null)).rejects.toThrow("invalid capture rect");
	});

	it("clamps negative origin and fails clearly when the element is off-viewport", async () => {
		await captureElementScreenshot(7, { ...rect, x: -5, y: -8 });
		expect(mocks.captureArgs.at(-1)).toEqual({ x: 0, y: 0, width: 300, height: 200 });

		mocks.captureResult = {
			isEmpty: () => true,
			toPNG: () => Buffer.from(""),
			getSize: () => ({ width: 0, height: 0 }),
		};
		await expect(captureElementScreenshot(7, rect)).rejects.toThrow("viewport");
	});
});
