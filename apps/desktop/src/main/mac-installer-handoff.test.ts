import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	handOffToInstaller,
	MACOS_SHIPIT_JOB_LABEL,
	resolveMacInstallerJobLabel,
	waitForInstallerHandoff,
} from "./mac-installer-handoff";

it("hands off to the job registered for the packaged FlowsToken bundle identity", async () => {
	const buildSource = readFileSync(join(import.meta.dirname, "../../scripts/desktop-build-environment.mjs"), "utf8");
	const appId = /\bVETTA_APP_ID:\s*"([A-Za-z0-9.-]+)"/.exec(buildSource)?.[1];
	if (!appId) throw new Error("The packaging default must declare a concrete bundle identifier");
	const expectedLabel = `${appId}.ShipIt`;
	const start = vi.fn(() => true);
	await expect(
		handOffToInstaller({
			label: MACOS_SHIPIT_JOB_LABEL,
			probe: (label) => label === expectedLabel,
			start,
			timeoutMs: 0,
		}),
	).resolves.toBe("started");
	expect(start).toHaveBeenCalledWith(expectedLabel);
});

it("derives custom installer labels from an explicit valid bundle identity", () => {
	expect(resolveMacInstallerJobLabel(" com.example.desktop ")).toBe("com.example.desktop.ShipIt");
	for (const invalid of ["", "desktop", "com.example/desktop", "com.example;other"])
		expect(() => resolveMacInstallerJobLabel(invalid)).toThrow("Invalid installer bundle identifier");
});

describe("waitForInstallerHandoff", () => {
	it("returns as soon as the installer job shows up", async () => {
		const probe = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
		const sleep = vi.fn(async () => {});

		await expect(waitForInstallerHandoff({ label: "com.example.ShipIt", probe, sleep, intervalMs: 1 })).resolves.toBe(
			true,
		);
		expect(probe).toHaveBeenCalledTimes(3);
		expect(probe).toHaveBeenLastCalledWith("com.example.ShipIt");
	});

	// 等不到也必须放行：卡在这里等于应用永远不退出，而 launchd 要等目标进程退出
	// 才 spawn ShipIt——那是死锁，退出至少让下一次启动能接着装。
	it("gives up after the timeout instead of blocking the quit forever", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const probe = vi.fn().mockReturnValue(false);
		const sleep = vi.fn(async (ms: number) => {
			now += ms;
		});

		await expect(
			waitForInstallerHandoff({
				label: "com.example.ShipIt",
				probe,
				sleep,
				timeoutMs: 1_000,
				intervalMs: 250,
			}),
		).resolves.toBe(false);
		expect(probe).toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it("does not sleep when the job is already there", async () => {
		const sleep = vi.fn(async () => {});

		await expect(waitForInstallerHandoff({ label: "com.example.ShipIt", probe: () => true, sleep })).resolves.toBe(
			true,
		);
		expect(sleep).not.toHaveBeenCalled();
	});
});

describe("handOffToInstaller", () => {
	// Squirrel 只提交作业、不连 mach service，launchd 于是永远不 spawn ShipIt
	// （runs = 0、port = 0x0）。必须由我们补这一脚，否则「退出了但版本没变」。
	it("starts the job once it shows up", async () => {
		const start = vi.fn().mockReturnValue(true);

		await expect(
			handOffToInstaller({ label: "com.example.ShipIt", probe: () => true, start, sleep: async () => {} }),
		).resolves.toBe("started");
		expect(start).toHaveBeenCalledWith("com.example.ShipIt");
	});

	it("does not try to start a job that never appeared", async () => {
		const start = vi.fn();
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await expect(
			handOffToInstaller({
				label: "com.example.ShipIt",
				probe: () => false,
				start,
				timeoutMs: 10,
				intervalMs: 5,
				sleep: async (ms: number) => {
					now += ms;
				},
			}),
		).resolves.toBe("job-missing");
		expect(start).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it("reports a failed start instead of pretending it worked", async () => {
		await expect(
			handOffToInstaller({
				label: "com.example.ShipIt",
				probe: () => true,
				start: () => false,
				sleep: async () => {},
			}),
		).resolves.toBe("start-failed");
	});
});
