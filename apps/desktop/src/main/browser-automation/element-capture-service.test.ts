import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	fromId: vi.fn(),
	capturePage: vi.fn(),
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
		mocks.capturePage.mockResolvedValue({
			isEmpty: () => false,
			toPNG: () => Buffer.from("png"),
			getSize: () => ({ width: 600, height: 400 }),
		});
		mocks.fromId.mockReturnValue(guest());
	});

	it("captures the element rect of a webview guest and persists a png", async () => {
		const result = await captureElementScreenshot(7, rect);
		expect(mocks.capturePage).toHaveBeenCalledWith({ x: 10, y: 20, width: 300, height: 200 });
		expect(result.width).toBe(600);
		expect(result.path).toContain("element-");
		expect(mocks.writeFile).toHaveBeenCalled();
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
		expect(mocks.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 300, height: 200 });

		mocks.capturePage.mockResolvedValue({
			isEmpty: () => true,
			toPNG: () => Buffer.from(""),
			getSize: () => ({ width: 0, height: 0 }),
		});
		await expect(captureElementScreenshot(7, rect)).rejects.toThrow("viewport");
	});
});
