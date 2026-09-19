import { useCallback, useEffect, useState } from "react";
import type { FlowstokenAccountSnapshot } from "../../../../preload/api-types/flowstoken.js";

export interface FlowstokenAccountSettingsModel {
	snapshot: FlowstokenAccountSnapshot | null;
	busy: boolean;
	error: string | null;
	username: string;
	password: string;
	setUsername: (value: string) => void;
	setPassword: (value: string) => void;
	refresh: () => Promise<void>;
	loginBrowser: () => Promise<void>;
	loginPassword: () => Promise<void>;
	logout: () => Promise<void>;
	ensureKeys: () => Promise<void>;
	openTopup: () => Promise<void>;
	openConsole: () => Promise<void>;
}

export function useFlowstokenAccountSettingsModel(): FlowstokenAccountSettingsModel {
	const [snapshot, setSnapshot] = useState<FlowstokenAccountSnapshot | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");

	const refresh = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const next = await window.vetta.flowstoken.refresh();
			setSnapshot(next);
			if (next.lastError) setError(next.lastError);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const run = useCallback(async (action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, []);

	return {
		snapshot,
		busy,
		error,
		username,
		password,
		setUsername,
		setPassword,
		refresh,
		loginBrowser: () =>
			run(async () => {
				const result = await window.vetta.flowstoken.loginWithBrowser();
				if (result.snapshot) setSnapshot(result.snapshot);
				if (!result.ok) setError(result.error ?? "登录失败");
			}),
		loginPassword: () =>
			run(async () => {
				const result = await window.vetta.flowstoken.loginWithPassword(username, password);
				if (result.snapshot) setSnapshot(result.snapshot);
				if (!result.ok) setError(result.error ?? "登录失败");
				else setPassword("");
			}),
		logout: () =>
			run(async () => {
				setSnapshot(await window.vetta.flowstoken.logout());
			}),
		ensureKeys: () =>
			run(async () => {
				const result = await window.vetta.flowstoken.ensureKeys();
				if (result.snapshot) setSnapshot(result.snapshot);
				if (!result.ok) setError(result.error ?? "同步密钥失败");
			}),
		openTopup: async () => {
			await window.vetta.flowstoken.openExternal(snapshot?.topupUrl ?? "https://www.flowstoken.com/console/topup");
		},
		openConsole: async () => {
			await window.vetta.flowstoken.openExternal(snapshot?.consoleUrl ?? "https://www.flowstoken.com/console");
		},
	};
}
