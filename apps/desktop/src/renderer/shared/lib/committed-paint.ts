export type PaintBarrierResult = "painted" | "skipped-hidden" | "timeout";

export interface CommittedPaintOptions {
	/** Set to `null` when secondary work must never bypass a visible paint. */
	timeoutMs?: number | null;
}

/**
 * Let React commit and the browser present the current UI before starting
 * secondary work that can contend for the renderer or main-process event loop.
 */
export function waitForCommittedPaint({ timeoutMs = 100 }: CommittedPaintOptions = {}): Promise<PaintBarrierResult> {
	if (document.visibilityState === "hidden") return Promise.resolve("skipped-hidden");
	if (typeof window.requestAnimationFrame !== "function") {
		return new Promise((resolve) => window.setTimeout(() => resolve("timeout"), 0));
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: PaintBarrierResult): void => {
			if (settled) return;
			settled = true;
			if (timeoutId !== null) window.clearTimeout(timeoutId);
			document.removeEventListener("visibilitychange", onWindowHidden);
			resolve(result);
		};
		// 等待期间窗口被系统判为遮挡（锁屏/切 Space/守护进程拉起）会冻结 rAF：
		// 此刻没有可见内容可等，按 hidden 放行，避免无限挂起。
		const onWindowHidden = (): void => {
			if (document.visibilityState === "hidden") finish("skipped-hidden");
		};
		const timeoutId = timeoutMs === null ? null : window.setTimeout(() => finish("timeout"), timeoutMs);
		document.addEventListener("visibilitychange", onWindowHidden);
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => finish("painted"));
		});
	});
}
