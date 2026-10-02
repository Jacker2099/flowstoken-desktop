import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { catalogGroupForProvider, catalogGroupTitle } from "@shared/store/flowstoken-catalog";
import { flowstokenCatalogAtom } from "@shared/store/model-catalog-atoms";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import type { FlowstokenAccountSettingsModel } from "./useFlowstokenAccountSettingsModel";

export function FlowstokenAccountSettingsView({ model }: { model: FlowstokenAccountSettingsModel }): JSX.Element {
	const { t, i18n } = useTranslation("common");
	const catalog = useAtomValue(flowstokenCatalogAtom);
	const snapshot = model.snapshot;
	const loggedIn = Boolean(snapshot?.loggedIn && snapshot.user);
	const groupTitles = new Map(catalog?.groups.map((group) => [group.id, catalogGroupTitle(group, i18n.language)]));
	return (
		<div className="mx-auto w-full max-w-[720px] space-y-5 px-8 pb-8 pt-2">
			<header className="space-y-1">
				<h1 className="text-[20px] font-semibold tracking-tight text-foreground">{t("flowstokenAccount.title")}</h1>
				<p className="text-[13px] text-muted-foreground">{t("flowstokenAccount.description")}</p>
			</header>
			{model.error ? (
				<div
					role="alert"
					className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
				>
					{model.error}
				</div>
			) : null}
			<section className="space-y-4 rounded-xl border border-border/50 bg-card/40 p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="min-w-0">
						<div className="text-[14px] font-medium">{t("flowstokenAccount.status")}</div>
						<p className="truncate text-[13px] text-muted-foreground">
							{loggedIn
								? `${snapshot?.user?.displayName || snapshot?.user?.username} · ${t("flowstokenAccount.signedIn")}`
								: t("flowstokenAccount.signedOut")}
						</p>
					</div>
					<div className="flex gap-2">
						<Button variant="outline" size="sm" disabled={model.busy} onClick={() => void model.refresh()}>
							{t("flowstokenAccount.refresh")}
						</Button>
						{loggedIn ? (
							<Button variant="ghost" size="sm" disabled={model.busy} onClick={() => void model.logout()}>
								{t("flowstokenAccount.logout")}
							</Button>
						) : null}
					</div>
				</div>
				{loggedIn ? (
					<div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
						{[
							[t("flowstokenAccount.balance"), snapshot?.balanceUsd],
							[t("flowstokenAccount.used"), snapshot?.usedUsd],
						].map(([label, value]) => (
							<div key={label} className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5">
								<div className="text-[12px] text-muted-foreground">{label}</div>
								<div className="mt-1 text-[20px] font-semibold tabular-nums tracking-tight">{value}</div>
							</div>
						))}
					</div>
				) : (
					<div className="space-y-3">
						<div className="grid gap-2">
							<Input
								aria-label={t("flowstokenAccount.username")}
								placeholder={t("flowstokenAccount.username")}
								value={model.username}
								onChange={(event) => model.setUsername(event.target.value)}
								disabled={model.busy}
								autoComplete="username"
							/>
							<Input
								aria-label={t("flowstokenAccount.password")}
								type="password"
								placeholder={t("flowstokenAccount.password")}
								value={model.password}
								onChange={(event) => model.setPassword(event.target.value)}
								disabled={model.busy}
								autoComplete="current-password"
							/>
						</div>
						<div className="flex flex-wrap gap-2">
							<Button variant="primary" disabled={model.busy} onClick={() => void model.loginBrowser()}>
								{t("flowstokenAccount.browserLogin")}
							</Button>
							<Button
								variant="outline"
								disabled={model.busy || !model.username || !model.password}
								onClick={() => void model.loginPassword()}
							>
								{t("flowstokenAccount.passwordLogin")}
							</Button>
						</div>
					</div>
				)}
			</section>
			{loggedIn ? (
				<section className="space-y-3 rounded-xl border border-border/50 bg-card/40 p-4">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<h2 className="text-[14px] font-medium">{t("flowstokenAccount.groups")}</h2>
							<p className="text-[12px] text-muted-foreground">{t("flowstokenAccount.groupHint")}</p>
						</div>
						<Button variant="outline" size="sm" disabled={model.busy} onClick={() => void model.ensureKeys()}>
							{t("flowstokenAccount.sync")}
						</Button>
					</div>
					<ul className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2.5">
						{(snapshot?.groups ?? []).map((group) => {
							const metadata = catalogGroupForProvider(catalog, group.providerId);
							const label = metadata
								? catalogGroupTitle(metadata, i18n.resolvedLanguage ?? i18n.language)
								: group.labelZh;
							const count = metadata?.vendors
								.flatMap((vendor) => vendor.models)
								.filter((entry) => !entry.image && (!entry.kind || entry.kind === "chat")).length;
							return (
								<li
									key={group.groupId}
									className="min-w-0 rounded-lg border border-border/50 bg-background/20 px-3 py-2.5"
								>
									<div className="flex min-w-0 items-center justify-between gap-2">
										<span title={label} className="truncate text-[13px] font-medium">
											{label}
										</span>
										<span
											className={`shrink-0 text-[11px] ${group.enabled && group.wired ? "text-emerald-400" : "text-muted-foreground"}`}
										>
											{t(
												!group.enabled
													? "flowstokenAccount.unavailable"
													: group.wired
														? "flowstokenAccount.ready"
														: "flowstokenAccount.pending",
											)}
										</span>
									</div>
									{count !== undefined ? (
										<p className="mt-1 text-[11px] text-muted-foreground">
											{t("flowstokenAccount.models", { count })}
										</p>
									) : null}
								</li>
							);
						})}
					</ul>
					{snapshot?.groups.length === 0 ? (
						<p className="text-[13px] text-muted-foreground">{t("flowstokenAccount.emptyGroups")}</p>
					) : null}
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" size="sm" onClick={() => void model.openTopup()}>
							{t("flowstokenAccount.topup")}
						</Button>
						<Button variant="ghost" size="sm" onClick={() => void model.openConsole()}>
							{t("flowstokenAccount.console")}
						</Button>
					</div>
				</section>
			) : null}
			{loggedIn ? (
				<section className="space-y-3 rounded-xl border border-border/50 bg-card/40 p-4">
					<h2 className="text-[14px] font-medium">{t("flowstokenAccount.usage")}</h2>
					{(snapshot?.usage.length ?? 0) === 0 ? (
						<p className="text-[13px] text-muted-foreground">{t("flowstokenAccount.noUsage")}</p>
					) : (
						<ul className="space-y-2.5">
							{snapshot?.usage.slice(0, 6).map((row) => (
								<li key={row.id} className="flex items-center justify-between gap-3 text-[12px]">
									<div className="min-w-0">
										<div title={row.modelName} className="truncate font-medium">
											{row.modelName || t("flowstokenAccount.unknownModel")}
										</div>
										<p className="text-[11px] text-muted-foreground">
											{row.createdAt
												? new Date(row.createdAt * (row.createdAt < 1e12 ? 1000 : 1)).toLocaleString(
														i18n.language,
													)
												: "—"}
											{row.group ? ` · ${groupTitles.get(row.group) ?? row.group}` : ""}
										</p>
									</div>
									<span className="shrink-0 text-muted-foreground tabular-nums">
										{row.promptTokens + row.completionTokens} tok
									</span>
								</li>
							))}
						</ul>
					)}
				</section>
			) : null}
		</div>
	);
}
