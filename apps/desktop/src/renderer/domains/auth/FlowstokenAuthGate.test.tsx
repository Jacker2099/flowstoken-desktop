// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FlowstokenAuthGate } from "./FlowstokenAuthGate";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const mocks = vi.hoisted(() => ({
	getSnapshot: vi.fn(),
	loginWithBrowser: vi.fn(),
	ensureKeys: vi.fn(),
	openExternal: vi.fn(),
	onAccountChanged: vi.fn(() => () => {}),
}));

beforeAll(() => {
	(window as { vetta?: unknown }).vetta = { flowstoken: mocks };
	mocks.getSnapshot.mockResolvedValue({ loggedIn: false });
	mocks.loginWithBrowser.mockResolvedValue({ ok: false, error: "closed" });
	mocks.ensureKeys.mockResolvedValue({ ok: true });
});

describe("FlowstokenAuthGate", () => {
	it("auto-opens the browser login once, and never again on remount", async () => {
		const first = render(
			<FlowstokenAuthGate>
				<div>app</div>
			</FlowstokenAuthGate>,
		);
		await waitFor(() => expect(mocks.loginWithBrowser).toHaveBeenCalledTimes(1));
		first.unmount();

		render(
			<FlowstokenAuthGate>
				<div>app</div>
			</FlowstokenAuthGate>,
		);
		await waitFor(() => expect(screen.getByText("flowstokenAuth.loginButton")).toBeTruthy());
		// Second mount must not auto-open again — the manual button stays available.
		expect(mocks.loginWithBrowser).toHaveBeenCalledTimes(1);
	});

	it("renders children when the snapshot says logged in", async () => {
		mocks.getSnapshot.mockResolvedValueOnce({
			loggedIn: true,
			user: { id: 1, username: "u", displayName: "u", quota: 0, usedQuota: 0, requestCount: 0 },
			groups: [],
			usage: [],
		});
		render(
			<FlowstokenAuthGate>
				<div>app</div>
			</FlowstokenAuthGate>,
		);
		await waitFor(() => expect(screen.getByText("app")).toBeTruthy());
	});
});
