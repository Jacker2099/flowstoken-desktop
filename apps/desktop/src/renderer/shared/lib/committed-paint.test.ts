// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForCommittedPaint } from "./committed-paint";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("waitForCommittedPaint", () => {
	it("waits for two animation frames before releasing secondary work", async () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		const frames: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
			frames.push(callback);
			return frames.length;
		});
		const barrier = waitForCommittedPaint();
		let result: string | undefined;
		void barrier.then((value) => {
			result = value;
		});

		frames.shift()?.(0);
		await Promise.resolve();
		expect(result).toBeUndefined();
		frames.shift()?.(16);

		await expect(barrier).resolves.toBe("painted");
	});

	it("does not wait for a paint when the window is hidden", async () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		const requestFrame = vi.spyOn(window, "requestAnimationFrame");

		await expect(waitForCommittedPaint()).resolves.toBe("skipped-hidden");
		expect(requestFrame).not.toHaveBeenCalled();
	});

	it("releases the barrier when the window becomes occluded mid-wait", async () => {
		const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		const frames: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
			frames.push(callback);
			return frames.length;
		});
		const barrier = waitForCommittedPaint({ timeoutMs: null });
		let result: string | undefined;
		void barrier.then((value) => {
			result = value;
		});
		await Promise.resolve();
		expect(result).toBeUndefined();

		// Screen lock / Space switch / daemon relaunch occlude the window and freeze
		// rAF mid-wait; there is nothing visible to paint for, so the gate must open.
		visibility.mockReturnValue("hidden");
		document.dispatchEvent(new Event("visibilitychange"));

		await expect(barrier).resolves.toBe("skipped-hidden");
		expect(frames).toHaveLength(1);
	});

	it("releases the barrier on timeout when frames never arrive", async () => {
		vi.useFakeTimers();
		try {
			vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
			vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
			const barrier = waitForCommittedPaint({ timeoutMs: 50 });
			let result: string | undefined;
			void barrier.then((value) => {
				result = value;
			});

			await vi.advanceTimersByTimeAsync(60);
			expect(result).toBe("timeout");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not let a timeout bypass a required visible paint", async () => {
		vi.useFakeTimers();
		try {
			vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
			const frames: FrameRequestCallback[] = [];
			vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
				frames.push(callback);
				return frames.length;
			});
			const barrier = waitForCommittedPaint({ timeoutMs: null });
			let settled = false;
			void barrier.then(() => {
				settled = true;
			});

			await vi.advanceTimersByTimeAsync(1_000);
			expect(settled).toBe(false);

			frames.shift()?.(0);
			frames.shift()?.(16);
			await expect(barrier).resolves.toBe("painted");
		} finally {
			vi.useRealTimers();
		}
	});
});
