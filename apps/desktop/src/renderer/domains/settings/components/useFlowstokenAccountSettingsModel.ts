import { revalidateFlowstokenCatalog } from "@shared/store/flowstoken-catalog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FlowstokenAccountSnapshot } from "../../../../preload/api-types/flowstoken.js";

export interface FlowstokenAccountSettingsModel {
	snapshot: FlowstokenAccountSnapshot | null;
	busy: boolean;
	authorizing: boolean;
	error: string | null;
	username: string;
	password: string;
	setUsername: (value: string) => void;
	setPassword: (value: string) => void;
	refresh: () => Promise<void>;
	loginBrowser: () => Promise<void>;
	cancelLogin: () => Promise<void>;
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
	const [snapshot, setSnapshot] = useState<FlowstokenAccountSnapshot | null>(null);
	const [busy, setBusy] = useState(false);
	const [authorizing, setAuthorizing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const applySnapshot = useCallback((next: FlowstokenAccountSnapshot) => {
		accountId.current = next.user?.id ?? null;
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
			if (nextSnapshot.loggedIn || nextId !== accountId.current) setAuthorizing(false);
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

	async function readActionResult<Result>(
		pending: Promise<Result>,
		current: number,
		version: number,
	): Promise<Result | undefined> {
		try {
			return await pending;
		} catch (error) {
			if (!mounted.current || current !== epoch.current || version !== snapshotVersion.current) return undefined;
			throw error;
		}
	}

	return {
		snapshot,
		busy,
		authorizing,
		error,
		username,
		password,
		setUsername,
		setPassword,
		refresh,
		loginBrowser: () =>
			run(async (current) => {
				const version = snapshotVersion.current;
				setAuthorizing(true);
				try {
					const result = await readActionResult(window.vetta.flowstoken.loginWithBrowser(), current, version);
					if (!result || !mounted.current || current !== epoch.current) return;
					if (version === snapshotVersion.current) {
						if (result.snapshot) applySnapshot(result.snapshot);
						if (!result.ok) setError(result.error ?? t("flowstokenAccount.loginFailed"));
					}
				} finally {
					if (mounted.current && current === epoch.current) setAuthorizing(false);
				}
			}),
		cancelLogin: async () => {
			const current = epoch.current;
			const version = snapshotVersion.current;
			try {
				await readActionResult(window.vetta.flowstoken.cancelLogin(), current, version);
			} catch (error) {
				if (mounted.current && current === epoch.current)
					setError(error instanceof Error ? error.message : String(error));
			}
		},
		loginPassword: () =>
			run(async (current) => {
				const version = snapshotVersion.current;
				const result = await readActionResult(
					window.vetta.flowstoken.loginWithPassword(username, password),
					current,
					version,
				);
				if (!result || !mounted.current || current !== epoch.current) return;
				if (version === snapshotVersion.current) {
					if (result.snapshot) applySnapshot(result.snapshot);
					if (!result.ok) setError(result.error ?? t("flowstokenAccount.loginFailed"));
				}
				if (result.ok) setPassword("");
			}),
		logout: () =>
			run(async (current) => {
				const version = snapshotVersion.current;
				const next = await readActionResult(window.vetta.flowstoken.logout(), current, version);
				if (!next || !mounted.current || current !== epoch.current) return;
				setPassword("");
				if (version === snapshotVersion.current) applySnapshot(next);
			}),
		ensureKeys: () =>
			run(async (current) => {
				const version = snapshotVersion.current;
				const result = await readActionResult(window.vetta.flowstoken.ensureKeys(), current, version);
				if (!result || !mounted.current || current !== epoch.current) return;
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
