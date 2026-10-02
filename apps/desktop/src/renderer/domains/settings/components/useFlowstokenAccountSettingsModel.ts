import { revalidateFlowstokenCatalog } from "@shared/store/flowstoken-catalog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
	const { t } = useTranslation("common");
	const epoch = useRef(0);
	const snapshotVersion = useRef(0);
	const mounted = useRef(true);
	const accountId = useRef<number | null>(null);
	const latestSnapshot = useRef<FlowstokenAccountSnapshot | null>(null);
	const [snapshot, setSnapshot] = useState<FlowstokenAccountSnapshot | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const applySnapshot = useCallback((next: FlowstokenAccountSnapshot) => {
		accountId.current = next.user?.id ?? null;
		latestSnapshot.current = next;
		setSnapshot(next);
	}, []);

	const refresh = useCallback(async () => {
		const current = ++epoch.current;
		const version = snapshotVersion.current;
		setBusy(true);
		setError(null);
		try {
			const next = await window.vetta.flowstoken.refresh();
			if (!mounted.current || current !== epoch.current) return;
			if (version === snapshotVersion.current) {
				applySnapshot(next);
				setError(next.lastError ?? null);
			}
			// 自动静默检测：若已登录且有未接入分组，全自动在后台补齐，无需人工点击
			const latest = latestSnapshot.current;
			const ensureVersion = snapshotVersion.current;
			if (latest?.loggedIn && latest.groups?.some((g) => g.enabled && !g.wired)) {
				void window.vetta.flowstoken
					.ensureKeys()
					.then((res) => {
						if (
							mounted.current &&
							current === epoch.current &&
							ensureVersion === snapshotVersion.current &&
							res.snapshot
						)
							applySnapshot(res.snapshot);
					})
					.catch((e) => {
						console.warn("[AccountSettings] Auto ensureKeys failed:", e);
					});
			}
		} catch (err) {
			if (mounted.current && current === epoch.current && version === snapshotVersion.current)
				setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (mounted.current && current === epoch.current) setBusy(false);
		}
	}, [applySnapshot]);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		const unsub = window.vetta?.flowstoken?.onAccountChanged?.((nextSnapshot) => {
			++snapshotVersion.current;
			const nextId = nextSnapshot.user?.id ?? null;
			if (nextId !== accountId.current) {
				++epoch.current;
				setPassword("");
			}
			setBusy(false);
			setError(nextSnapshot.lastError ?? null);
			applySnapshot(nextSnapshot);
		});
		return () => {
			mounted.current = false;
			++epoch.current;
			if (typeof unsub === "function") unsub();
		};
	}, [applySnapshot, refresh]);

	const run = useCallback(async (action: (current: number) => Promise<void>) => {
		const current = ++epoch.current;
		setBusy(true);
		setError(null);
		try {
			await action(current);
		} catch (err) {
			if (mounted.current && current === epoch.current) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (mounted.current && current === epoch.current) setBusy(false);
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
			run(async (current) => {
				const version = snapshotVersion.current;
				const result = await window.vetta.flowstoken.loginWithBrowser();
				if (!mounted.current || current !== epoch.current) return;
				if (version === snapshotVersion.current) {
					if (result.snapshot) applySnapshot(result.snapshot);
					if (!result.ok) setError(result.error ?? t("flowstokenAccount.loginFailed"));
				}
			}),
		loginPassword: () =>
			run(async (current) => {
				const version = snapshotVersion.current;
				const result = await window.vetta.flowstoken.loginWithPassword(username, password);
				if (!mounted.current || current !== epoch.current) return;
				if (version === snapshotVersion.current) {
					if (result.snapshot) applySnapshot(result.snapshot);
					if (!result.ok) setError(result.error ?? t("flowstokenAccount.loginFailed"));
				}
				if (result.ok) setPassword("");
			}),
		logout: () =>
			run(async (current) => {
				const version = snapshotVersion.current;
				const next = await window.vetta.flowstoken.logout();
				if (!mounted.current || current !== epoch.current) return;
				setPassword("");
				if (version === snapshotVersion.current) applySnapshot(next);
			}),
		ensureKeys: () =>
			run(async (current) => {
				const version = snapshotVersion.current;
				const result = await window.vetta.flowstoken.ensureKeys();
				if (!mounted.current || current !== epoch.current) return;
				if (version === snapshotVersion.current) {
					if (result.snapshot) applySnapshot(result.snapshot);
					if (!result.ok) setError(result.error ?? t("flowstokenAccount.syncFailed"));
				}
				if (result.ok) await revalidateFlowstokenCatalog(Date.now(), { force: true });
			}),
		openTopup: async () => {
			await window.vetta.flowstoken.openExternal(snapshot?.topupUrl ?? "https://www.flowstoken.com/console/topup");
		},
		openConsole: async () => {
			await window.vetta.flowstoken.openExternal(snapshot?.consoleUrl ?? "https://www.flowstoken.com/console");
		},
	};
}
