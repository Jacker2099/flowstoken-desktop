// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyInitialTheme, MODE_STORAGE_KEY, syncInitialNativeTheme } from "./apply";

describe("default appearance", () => {
	beforeEach(() => {
		localStorage.clear();
		document.documentElement.removeAttribute("data-mode");
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
		});
	});

	it("uses the light palette before React mounts even when the operating system is dark", () => {
		applyInitialTheme();
		expect(document.documentElement.dataset.mode).toBe("light");
		expect(document.documentElement.style.getPropertyValue("--background")).toBe("rgb(255, 255, 255)");
		expect(localStorage.getItem(MODE_STORAGE_KEY)).toBeNull();
	});

	it.each(["light", "dark", "auto"])("preserves the saved %s preference", (mode) => {
		localStorage.setItem(MODE_STORAGE_KEY, mode);
		applyInitialTheme();
		expect(document.documentElement.dataset.mode).toBe(mode === "auto" ? "dark" : mode);
		expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe(mode);
	});

	it("uses the light default for an invalid stored value without rewriting customer preferences", () => {
		localStorage.setItem(MODE_STORAGE_KEY, "unknown-theme-mode");
		applyInitialTheme();
		expect(document.documentElement.dataset.mode).toBe("light");
		expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe("unknown-theme-mode");
	});

	it.each([
		[null, "light"],
		["dark", "dark"],
		["light", "light"],
		["auto", "dark"],
		["system", "dark"],
		["invalid", "light"],
	])("sets HTML mode before the module bundle runs for saved preference %s", (saved, expected) => {
		const html = readFileSync(join(import.meta.dirname, "../../index.html"), "utf8");
		const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
		if (!script) throw new Error("The initial theme script is missing");
		runInNewContext(script, {
			document,
			localStorage: { getItem: () => saved },
			matchMedia: () => ({ matches: true }),
		});
		expect(document.documentElement.dataset.mode).toBe(expected);
		expect(document.documentElement.style.colorScheme).toBe(expected);
	});

	it("does not report native theme readiness until the initial light appearance has been applied", async () => {
		let finish!: () => void;
		const set = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		Object.defineProperty(window, "vetta", { configurable: true, value: { theme: { set } } });
		let ready = false;
		const pending = syncInitialNativeTheme().then(() => {
			ready = true;
		});
		await Promise.resolve();
		expect(set).toHaveBeenCalledWith("light");
		expect(ready).toBe(false);
		finish();
		await pending;
		expect(ready).toBe(true);
	});
});
