// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FlowstokenAccountSnapshot } from "../../../preload/api-types/flowstoken.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowstokenAuthGate as AuthGateComponent } from "./FlowstokenAuthGate";

let FlowstokenAuthGate: typeof AuthGateComponent;
let accountListener: ((snapshot: FlowstokenAccountSnapshot) => void) | undefined;

const loggedOut: FlowstokenAccountSnapshot = {
	loggedIn: false, user: null, groups: [], usage: [], balanceUsd: "$0.00", usedUsd: "$0.00",
	siteUrl: "https://www.flowstoken.com", topupUrl: "https://www.flowstoken.com/console/topup", consoleUrl: "https://www.flowstoken.com/console",
};
const loggedIn: FlowstokenAccountSnapshot = {
	...loggedOut, loggedIn: true,
	user: { id: 1, username: "fixture", displayName: "Fixture", quota: 0, usedQuota: 0, requestCount: 0 },
};

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const mocks = vi.hoisted(() => ({
	getSnapshot: vi.fn(),
	loginWithBrowser: vi.fn(),
	cancelLogin: vi.fn(),
	ensureKeys: vi.fn(),
	openExternal: vi.fn(),
	onAccountChanged: vi.fn<(listener: (snapshot: FlowstokenAccountSnapshot) => void) => () => void>(),
}));

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	(window as { vetta?: unknown }).vetta = { flowstoken: mocks };
	mocks.getSnapshot.mockResolvedValue({ loggedIn: false });
	mocks.loginWithBrowser.mockResolvedValue({ ok: false, error: "closed" });
	mocks.cancelLogin.mockResolvedValue(undefined);
	mocks.ensureKeys.mockResolvedValue({ ok: true });
	accountListener = undefined;
	mocks.onAccountChanged.mockImplementation((listener) => {
		accountListener = listener;
		return () => { accountListener = undefined; };
	});
	({ FlowstokenAuthGate } = await import("./FlowstokenAuthGate"));
});

describe("FlowstokenAuthGate", () => {
	it("shows browser authorization waiting state and allows cancellation without reopening automatically", async () => {
		let finish!: (value: { ok: boolean; error: string }) => void;
		mocks.loginWithBrowser.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		mocks.cancelLogin.mockImplementation(async () => { finish({ ok: false, error: "fixture canceled" }); });
		render(<FlowstokenAuthGate><div>app</div></FlowstokenAuthGate>);
		const cancel = await screen.findByRole("button", { name: "flowstokenAuth.cancelAuthorization" });
		expect(screen.getByText("flowstokenAuth.statusOpening")).toBeTruthy();
		await act(async () => { fireEvent.click(cancel); });
		await screen.findByText("fixture canceled");
		expect(mocks.cancelLogin).toHaveBeenCalledOnce();
		expect(mocks.loginWithBrowser).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "flowstokenAuth.cancelAuthorization" })).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
	});
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

	it("enters the app after login without repeating a failed key synchronization", async () => {
		mocks.ensureKeys.mockClear();
		mocks.loginWithBrowser.mockResolvedValueOnce({
			ok: true,
			snapshot: {
				loggedIn: true,
				user: { id: 1 },
				groups: [{ enabled: true, wired: false }],
				lastError: "Temporary synchronization failure",
			},
		});
		render(<FlowstokenAuthGate><div>recovered app</div></FlowstokenAuthGate>);
		await screen.findByText("recovered app");
		expect(mocks.ensureKeys).not.toHaveBeenCalled();
	});

	it("shows a transient status error without automatically opening another login window", async () => {
		mocks.getSnapshot.mockRejectedValueOnce(new Error("Retry after 60 seconds"));
		render(<FlowstokenAuthGate><div>app</div></FlowstokenAuthGate>);
		await screen.findByText("Retry after 60 seconds");
		expect(mocks.loginWithBrowser).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "flowstokenAuth.loginButton" })).toBeTruthy();
	});

	it("does not reopen the login window after an existing signed-in user explicitly logs out", async () => {
		mocks.getSnapshot.mockResolvedValueOnce(loggedIn);
		render(<FlowstokenAuthGate><div>existing account</div></FlowstokenAuthGate>);
		await screen.findByText("existing account");
		await act(async () => { accountListener?.(loggedOut); });
		await screen.findByRole("button", { name: "flowstokenAuth.loginButton" });
		expect(mocks.loginWithBrowser).not.toHaveBeenCalled();
	});

	it("does not let an old startup response overwrite a newly authenticated account", async () => {
		let resolve!: (snapshot: FlowstokenAccountSnapshot) => void;
		mocks.getSnapshot.mockReturnValueOnce(new Promise<FlowstokenAccountSnapshot>((done) => { resolve = done; }));
		render(<FlowstokenAuthGate><div>current account</div></FlowstokenAuthGate>);
		await act(async () => { accountListener?.(loggedIn); });
		await screen.findByText("current account");
		await act(async () => { resolve(loggedOut); });
		expect(screen.getByText("current account")).toBeTruthy();
		expect(mocks.loginWithBrowser).not.toHaveBeenCalled();
	});

	it("does not apply a late login reply after a newer logout event", async () => {
		let resolve!: (result: { ok: boolean; snapshot: FlowstokenAccountSnapshot }) => void;
		mocks.loginWithBrowser.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
		render(<FlowstokenAuthGate><div>stale account</div></FlowstokenAuthGate>);
		await waitFor(() => expect(mocks.loginWithBrowser).toHaveBeenCalledOnce());
		await act(async () => { accountListener?.(loggedOut); resolve({ ok: true, snapshot: loggedIn }); });
		expect(screen.queryByText("stale account")).toBeNull();
		expect(screen.getByRole("button", { name: "flowstokenAuth.loginButton" })).toBeTruthy();
	});
});
