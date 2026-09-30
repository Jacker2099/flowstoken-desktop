/// <reference types="@wdio/globals/types" />
import type {} from "@wdio/electron-service";
import { installUpdaterAuthFixture, UPDATER_ACCOUNT_SNAPSHOT } from "./updater-auth-fixture.js";

const packaged = process.env.VETTA_E2E_PACKAGED === "1";
const UPDATE_TIMEOUT_MS = 60_000;

async function focusMainRenderer(): Promise<void> {
	await browser.waitUntil(
		async () => {
			for (const handle of await browser.getWindowHandles()) {
				await browser.switchToWindow(handle);
				if ((await browser.getUrl()).includes("index.html")) return true;
			}
			return false;
		},
		{
			timeout: UPDATE_TIMEOUT_MS,
			timeoutMsg: "Main renderer window was not available before updater E2E",
		},
	);
}

async function waitForUpdaterPhase(
	element: WebdriverIO.Element,
	phase: "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error",
): Promise<void> {
	await browser.waitUntil(async () => (await element.getAttribute("data-updater-phase")) === phase, {
		timeout: UPDATE_TIMEOUT_MS,
		timeoutMsg: `Updater UI did not reach the ${phase} phase`,
	});
}

async function activateRendererControl(element: WebdriverIO.Element): Promise<void> {
	await browser.execute((control) => control.click(), element);
}

describe("Vetta Desktop packaged updater", () => {
	(packaged ? it : it.skip)("checks the configured update feed through the settings UI", async () => {
		await browser.waitUntil(
			async () => {
				const ready = await browser.execute(() => document.readyState);
				return ready === "complete" || ready === "interactive";
			},
			{ timeout: UPDATE_TIMEOUT_MS, timeoutMsg: "Renderer was not ready before updater E2E" },
		);

		const currentVersion = await browser.electron.execute((electron) => electron.app.getVersion());
		expect(currentVersion).toMatch(/^\d+\.\d+\.\d+$/);

		await focusMainRenderer();
		// Isolate account IPC only; real login is covered separately by auth component/IPC tests.
		await browser.electron.execute(installUpdaterAuthFixture, UPDATER_ACCOUNT_SNAPSHOT);
		await browser.refresh();
		await focusMainRenderer();
		// Observe the normal account UI: raw window.vetta calls lack the renderer's private host token.
		await browser.execute(() => {
			window.location.hash = "/settings/flowstoken";
		});
		const fixtureName = UPDATER_ACCOUNT_SNAPSHOT.user?.displayName || UPDATER_ACCOUNT_SNAPSHOT.user?.username;
		if (!fixtureName) throw new Error("Updater account fixture has no display name");
		const loggedInText = `${fixtureName}（已登录）`;
		const accountStatus = await $(`div=${loggedInText}`).getElement();
		await accountStatus.waitForDisplayed({ timeout: UPDATE_TIMEOUT_MS });
		expect(await accountStatus.getText()).toBe(loggedInText);
		await browser.execute(() => {
			window.location.hash = "/settings/general";
		});
		const checkButton = await $('[data-testid="updater-check"]').getElement();
		await checkButton.waitForDisplayed({ timeout: UPDATE_TIMEOUT_MS });
		await activateRendererControl(checkButton);
		await waitForUpdaterPhase(checkButton, "checking");

		if (process.platform === "linux") {
			await waitForUpdaterPhase(checkButton, "available");
			const detail = await $('[data-testid="updater-detail"]');
			await detail.waitForDisplayed({ timeout: UPDATE_TIMEOUT_MS });
			expect(await detail.getText()).toContain(currentVersion);

			const downloadButton = await $('[data-testid="updater-primary"]').getElement();
			await activateRendererControl(downloadButton);
			await waitForUpdaterPhase(checkButton, "ready");
		} else {
			await waitForUpdaterPhase(checkButton, "idle");
		}

		expect(await $("body").getText()).toContain(currentVersion);
	});
});
