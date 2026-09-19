import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { SettingsPageShellView } from "@vetta-org/theme-ui/settings";
import { Button } from "@shared/components/ui/button";
import { SettingsAiAssist } from "../ai-assist";
import { ModelsProvidersSection } from "./ModelsProvidersSection";
import { PresetProvidersSection } from "./PresetProvidersSection";
import type { ModelsSettingsModel } from "./useModelsSettingsModel";

export function ModelsSettingsView({ model }: { model: ModelsSettingsModel }): JSX.Element {
	const { t } = useTranslation("settings");
	const navigate = useNavigate();

	return (
		<SettingsPageShellView
			title={model.config ? t("modelSettings.title") : t("modelsTitle")}
			headerAction={model.config ? <SettingsAiAssist tabId="models" /> : undefined}
			loading={!model.config}
			loadingLabel={t("loading")}
			footer={
				model.config ? (
					<div className="mt-6 text-center text-[11px] text-muted-foreground/60">
						{t("configFilePath")}: ~/.vetta/agent/models.json
					</div>
				) : undefined
			}
		>
			{model.config && (
				<>
					<div className="mb-4 rounded-xl border border-border bg-card px-4 py-3">
						<div className="text-[14px] font-medium text-foreground">FlowsToken 一键接入</div>
						<p className="mt-1 text-[12px] text-muted-foreground">
							登录 FlowsToken 账户后，自动启用普通组 / 智能组 / 官方组，无需手动粘贴 API Key。
						</p>
						<Button
							className="mt-2"
							size="sm"
							variant="outline"
							onClick={() => void navigate({ to: "/settings/$tab", params: { tab: "flowstoken" } })}
						>
							打开 FlowsToken 账户
						</Button>
					</div>
					<PresetProvidersSection config={model.config} saveConfig={model.saveConfig} />
					<ModelsProvidersSection model={model} />
				</>
			)}
		</SettingsPageShellView>
	);
}
