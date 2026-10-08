/// <reference types="@wdio/globals/types" />
import type {} from "@wdio/electron-service";
import { writeFileSync } from "node:fs";
import path from "node:path";

interface LoginRecoveryAudit {
	installedBeforeReady: boolean;
	mockKeychainSwitch: boolean;
	initiallyAuthenticated: boolean;
	authMode: "embedded" | "system-browser";
	loginWindowsOpened: number;
	systemBrowserLaunches: number;
	desktopExchanges: number;
	importedRefreshCookies: number;
	firstVisibleTheme?: { native: { source: string; dark: boolean }; renderer: { mode: string; colorScheme: string; background: string } };
	safeStorage: Record<string, number>;
	requests: Array<{ host: string; path: string; method: string }>;
	rateLimitedResponses: number;
	unhandledErrors: string[];
	profile: string;
	home: string;
	preservedCiphertext: boolean;
	preservedCustomProviders: boolean;
	managedBindings: Array<{ providerId: string; binding: { accountId: number; groupId: string; tokenId: number }; hasPlaintextKey: boolean }>;
}

async function audit(): Promise<LoginRecoveryAudit> {
	return browser.electron.execute(() => {
		const fixture = (globalThis as unknown as { __flowstokenLoginRecoveryFixture?: { audit(): LoginRecoveryAudit } }).__flowstokenLoginRecoveryFixture;
		if (!fixture) throw new Error("The startup preload did not install the isolated login fixture");
		return fixture.audit();
	});
}

async function clickAccountRefresh(): Promise<void> {
	const button = await $("//button[normalize-space()='刷新' or normalize-space()='Refresh']");
	await button.waitForClickable({ timeout: 20_000, timeoutMsg: "Account refresh did not become available" });
	await button.click();
}

async function focusWindow(fragment: string): Promise<void> {
	await browser.waitUntil(async () => {
		for (const handle of await browser.getWindowHandles()) {
			try {
				await browser.switchToWindow(handle);
				if ((await browser.getUrl()).includes(fragment)) return true;
			} catch {
				// A successfully authenticated login window can close while handles are being enumerated.
			}
		}
		return false;
	}, { timeout: 30_000, timeoutMsg: `Expected native window was not available: ${fragment}` });
}

async function clickOneClickLogin(page = "https://www.flowstoken.com/login"): Promise<void> {
	await focusWindow("index.html");
	const button = await $("//button[normalize-space()='一键登录 FlowsToken 账户' or normalize-space()='Sign in with FlowsToken']");
	await button.waitForClickable({ timeout: 20_000, timeoutMsg: "The real one-click sign-in control remained unavailable" });
	await button.doubleClick();
	await focusWindow(page);
}

async function setRateLimit(seconds: number): Promise<number> {
	return browser.electron.execute((_electron, duration) => {
		const fixture = (globalThis as unknown as { __flowstokenLoginRecoveryFixture: { rateLimit(seconds: number): number } }).__flowstokenLoginRecoveryFixture;
		return fixture.rateLimit(duration);
	}, seconds);
}

async function finishFirstRunGuides(): Promise<void> {
	const skip = await $("//button[normalize-space()='跳过' or normalize-space()='Skip']");
	if (await skip.isExisting() && await skip.isDisplayed()) await skip.click();
	// The sidebar guide intentionally starts after the appearance wizard has
	// closed. Complete its visible steps before measuring account controls.
	await $(".driver-popover").waitForDisplayed({ timeout: 15_000 });
	for (let step = 0; step < 4; step++) {
		const popover = await $(".driver-popover");
		await popover.waitForDisplayed({ timeout: 10_000 });
		const previous = await popover.getText();
		const next = await $("//div[contains(@class,'driver-popover')]//button[normalize-space()='下一步' or normalize-space()='Next' or normalize-space()='完成' or normalize-space()='Done']");
		await next.waitForClickable({ timeout: 10_000 });
		const finalStep = /^(完成|Done)$/.test((await next.getText()).trim());
		await next.click();
		if (finalStep) {
			await $(".driver-overlay").waitForExist({ reverse: true, timeout: 10_000 });
			return;
		}
		await browser.waitUntil(async () => {
			const current = await $(".driver-popover");
			return await current.isExisting() && await current.isDisplayed() && await current.getText() !== previous;
		}, { timeout: 10_000, timeoutMsg: "The first-run guide did not advance after its visible button was clicked" });
	}
	throw new Error("The first-run guide did not reach its Done button");
}

async function readyLabelContrast(): Promise<Array<{ color: string; background: number[]; contrast: number }>> {
	return browser.execute(() => {
		const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
		if (!context) throw new Error("Cannot measure computed colors in the renderer");
		const rgba = (value: string): number[] => {
			// Let the same native renderer resolve rgb/rgba/OKLCH and convert to
			// sRGB, rather than assuming a particular CSS serialization.
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = value;
			context.fillRect(0, 0, 1, 1);
			const channels = context.getImageData(0, 0, 1, 1).data;
			return [channels[0]!, channels[1]!, channels[2]!, channels[3]! / 255];
		};
		const blend = (base: number[], layer: number[]) => base.map((value, index) => layer[index]! * layer[3]! + value * (1 - layer[3]!));
		const luminance = (rgb: number[]) => rgb.map((value) => {
			const normalized = value / 255;
			return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
		}).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0);
		return [...document.querySelectorAll("li span")].filter((span) => /^(已启用|Ready)$/.test(span.textContent?.trim() ?? "")).map((span) => {
			const ancestors: Element[] = [];
			for (let element: Element | null = span; element; element = element.parentElement) ancestors.unshift(element);
			const background = ancestors.reduce((base, element) => blend(base, rgba(getComputedStyle(element).backgroundColor)), [255, 255, 255]);
			const color = getComputedStyle(span).color;
			const foreground = blend(background, rgba(color));
			const [low, high] = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
			return { color, background, contrast: (high! + 0.05) / (low! + 0.05) };
		});
	});
}

async function exerciseSystemBrowserAuthorization(): Promise<void> {
	const page = "https://www.flowstoken.com/auth/desktop";
	// The external-browser boundary holds an already signed-in synthetic web
	// session. No installed browser profile or real web account is accessed.
	await focusWindow(page);
	const initialBrowser = await browser.getWindowHandle();
	const before = (await audit()).systemBrowserLaunches;
	await focusWindow("index.html");
	const cancel = await $("//button[normalize-space()='取消本次授权' or normalize-space()='Cancel authorization']");
	await cancel.waitForClickable({ timeout: 20_000 });
	await cancel.click();
	await browser.waitUntil(async () => /已取消|cancelled/i.test(await $("body").getText()), { timeout: 20_000 });
	expect((await audit()).systemBrowserLaunches).toBe(before);
	await browser.switchToWindow(initialBrowser);
	await browser.closeWindow();

	await clickOneClickLogin(page);
	expect((await audit()).systemBrowserLaunches).toBe(before + 1);
	await $("#fixture-deny").click();
	await browser.waitUntil(async () => (await browser.getUrl()).includes("/flowstoken/callback"), { timeout: 20_000 });
	await browser.closeWindow();
	await focusWindow("index.html");
	await browser.waitUntil(async () => /已取消|cancelled/i.test(await $("body").getText()), { timeout: 20_000 });
	expect((await audit()).desktopExchanges).toBe(0);

	await clickOneClickLogin(page);
	expect((await audit()).systemBrowserLaunches).toBe(before + 2);
	if (process.env.VETTA_E2E_LOGIN_RECOVERY_EXCHANGE_429 === "1") {
		const deadline = await setRateLimit(8);
		await $("#fixture-approve").click();
		await browser.waitUntil(async () => (await audit()).rateLimitedResponses === 1, { timeout: 10_000 });
		await focusWindow("index.html");
		await browser.waitUntil(async () => /请求过于频繁|Too many requests/i.test(await $("body").getText()), { timeout: 10_000 });
		const retry = await $("//button[normalize-space()='一键登录 FlowsToken 账户' or normalize-space()='Sign in with FlowsToken']");
		await retry.waitForClickable({ timeout: 10_000 });
		await retry.click();
		await browser.waitUntil(async () => retry.isEnabled(), { timeout: 10_000 });
		expect((await audit()).systemBrowserLaunches).toBe(before + 2);
		expect((await audit()).desktopExchanges).toBe(0);
		expect((await audit()).importedRefreshCookies).toBe(0);
		await browser.waitUntil(async () => Date.now() >= deadline + 1000, { timeout: 15_000 });
		await clickOneClickLogin(page);
		expect((await audit()).systemBrowserLaunches).toBe(before + 3);
	}
	await $("#fixture-approve").click();
	await browser.waitUntil(async () => (await audit()).importedRefreshCookies === 1, { timeout: 20_000 });
	expect((await audit()).desktopExchanges).toBe(1);
	await focusWindow("index.html");
}

async function exerciseOneClickLoginAfterCancellation(): Promise<void> {
	// The initial signed-out snapshot is allowed one automatic window. Close it before exercising the button.
	await focusWindow("https://www.flowstoken.com/login");
	await browser.closeWindow();
	await focusWindow("index.html");
	const before = (await audit()).loginWindowsOpened;
	await clickOneClickLogin();
	expect((await audit()).loginWindowsOpened).toBe(before + 1);
	await browser.closeWindow();
	await focusWindow("index.html");
	await browser.waitUntil(async () => /窗口已关闭|window was closed|window has been closed/i.test(await $("body").getText()), { timeout: 20_000 });
	expect((await audit()).loginWindowsOpened).toBe(before + 1);
	await clickOneClickLogin();
	expect((await audit()).loginWindowsOpened).toBe(before + 2);
	const signIn = await $("#fixture-sign-in").getElement();
	await signIn.waitForDisplayed({ timeout: 20_000 });
	await signIn.click();
	await focusWindow("index.html");
}

describe("isolated native login recovery", () => {
	afterEach(async function () {
		if (this.currentTest?.state !== "failed") return;
		const home = process.env.VETTA_E2E_LOGIN_HOME;
		if (!home) return;
		try {
			writeFileSync(path.join(home, "native-login-failure.json"), JSON.stringify({
				audit: await audit(),
				url: await browser.getUrl(),
				body: await $("body").getText(),
			}, null, 2) + "\n", { mode: 0o600 });
			await browser.saveScreenshot(path.join(home, "native-login-failure.png"));
		} catch {
			// Preserve the original assertion if the failed application has exited.
		}
	});
	it("starts the current app, wires three groups and preserves login through a rate limit without using Keychain", async () => {
		if (process.env.VETTA_E2E_LOGIN_RECOVERY !== "1") throw new Error("Login recovery E2E requires its isolated mode");
		await browser.waitUntil(async () => {
			for (const handle of await browser.getWindowHandles()) {
				await browser.switchToWindow(handle);
				if ((await browser.getUrl()).includes("index.html")) return true;
			}
			return false;
		}, { timeout: 60_000, timeoutMsg: "The newly built main renderer did not start" });
		expect((await audit()).installedBeforeReady).toBe(true);
		const initial = await audit();
		expect(initial.mockKeychainSwitch).toBe(false);
		if (initial.profile === "fresh") {
			await browser.waitUntil(async () => Boolean((await audit()).firstVisibleTheme), { timeout: 10_000 });
			const theme = (await audit()).firstVisibleTheme;
			expect(theme?.native).toEqual({ source: "light", dark: false });
			expect(theme?.renderer.mode).toBe("light");
			expect(theme?.renderer.colorScheme).toBe("light");
		}
		if (!initial.initiallyAuthenticated) {
			if (initial.authMode === "system-browser") await exerciseSystemBrowserAuthorization();
			else await exerciseOneClickLoginAfterCancellation();
		}
		await browser.execute(() => { window.location.hash = "/settings/flowstoken"; });
		await browser.waitUntil(async () => (await $("body").getText()).includes("Login Recovery E2E"), {
			timeout: 60_000, timeoutMsg: "Real account IPC did not reach the native account settings UI",
		});
		await finishFirstRunGuides();
		await browser.waitUntil(async () => browser.execute(() => {
			const cards = [...document.querySelectorAll("li")].map((entry) => entry.textContent ?? "");
			return ["Ordinary fixture", "Smart fixture", "Official fixture"].every((name) => cards.some((text) => text.includes(name) && /已启用|Ready/i.test(text)));
		}), { timeout: 60_000, timeoutMsg: "The real account service did not wire all three fixture groups" });
		const beforeLimit = await audit();
		const statusTextContrast = beforeLimit.profile === "fresh" ? await readyLabelContrast() : [];
		if (beforeLimit.profile === "fresh") {
			expect(statusTextContrast).toHaveLength(3);
			for (const label of statusTextContrast) expect(label.contrast).toBeGreaterThanOrEqual(4.5);
		}
		expect(Object.values(beforeLimit.safeStorage)).toEqual([0, 0, 0]);
		expect(beforeLimit.preservedCiphertext).toBe(true);
		expect(beforeLimit.preservedCustomProviders).toBe(true);
		expect(beforeLimit.unhandledErrors).toEqual([]);
		expect(beforeLimit.profile).toBe(process.env.VETTA_E2E_LOGIN_RECOVERY_PROFILE || "mixed-legacy");
		expect(beforeLimit.managedBindings.every((provider) => provider.binding.accountId === 7 && !provider.hasPlaintextKey)).toBe(true);
		expect(beforeLimit.requests.filter((request) => request.path.startsWith("/api/")).length).toBeLessThan(40);

		const deadline = await setRateLimit(8);
		await clickAccountRefresh();
		await browser.waitUntil(async () => (await audit()).rateLimitedResponses === beforeLimit.rateLimitedResponses + 1, { timeout: 10_000 });
		await clickAccountRefresh();
		expect((await $("body").getText()).includes("Login Recovery E2E")).toBe(true);
		expect((await audit()).rateLimitedResponses).toBe(beforeLimit.rateLimitedResponses + 1);
		await browser.waitUntil(async () => Date.now() >= deadline + 1000, { timeout: 15_000 });
		await clickAccountRefresh();
		await browser.waitUntil(async () => !(await $("body").getText()).match(/Too many requests|请求过于频繁/i), { timeout: 20_000 });
		const after = { ...await audit(), statusTextContrast };
		expect(Object.values(after.safeStorage)).toEqual([0, 0, 0]);
		expect(after.preservedCiphertext).toBe(true);
		expect(after.preservedCustomProviders).toBe(true);
		expect(after.unhandledErrors).toEqual([]);
		expect((await $("body").getText()).includes("Login Recovery E2E")).toBe(true);
		expect(after.requests.filter((request) => request.path.startsWith("/api/")).length).toBeLessThan(60);
		writeFileSync(path.join(after.home, "native-login-assertions.json"), JSON.stringify(after, null, 2) + "\n", { mode: 0o600 });
		await browser.saveScreenshot(path.join(after.home, "native-login-recovery.png"));
	});
});
