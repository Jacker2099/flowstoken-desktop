/** FlowsToken NewAPI endpoints and desktop provider ids (additive overlay). */

export const FLOWSTOKEN_SITE_URL = "https://www.flowstoken.com";
export const FLOWSTOKEN_API_ORIGIN = "https://www.flowstoken.com";
export const FLOWSTOKEN_OPENAI_BASE_URL = "https://www.flowstoken.com/v1";
export const FLOWSTOKEN_CONSOLE_URL = "https://www.flowstoken.com/console";
export const FLOWSTOKEN_TOPUP_URL = "https://www.flowstoken.com/console/topup";
export const FLOWSTOKEN_TOKEN_CONSOLE_URL = "https://www.flowstoken.com/console/token";

/** Electron session partition that holds the NewAPI login cookies. */
export const FLOWSTOKEN_SESSION_PARTITION = "persist:flowstoken-account";

export const FLOWSTOKEN_TURNSTILE_SITE_KEY = "0x4AAAAAAE1htZpHCGxMfHOT";

/** Curated default models for 普通组 (21 models) */
export const FLOWSTOKEN_DEFAULT_GROUP_MODELS: readonly string[] = [
	"claude-sonnet-5",
	"claude-sonnet-4-6",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-haiku-4-5",
	"claude-fable-5",
	"claude-fable-5-1",
	"deepseek-v4.1-flash",
	"deepseek-v4-flash",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.5",
	"gpt-5.6-terra",
	"gpt-6-astra",
	"claude-opus-4-5-20251101",
	"claude-haiku-4-5-20251001",
	"claude-sonnet-4-5-20250929",
	"codex-auto-review",
	"gpt-image-2",
];

/** 智能组 (唯一全自动选模模型) */
export const FLOWSTOKEN_SMART_GROUP_MODELS: readonly string[] = ["Bestoo-Auto"];

/** Curated default models for 官方组 (各大原厂直连精选) */
export const FLOWSTOKEN_OFFICIAL_GROUP_MODELS: readonly string[] = [
	// Anthropic 原厂
	"anthropic/claude-sonnet-4.6",
	"anthropic/claude-sonnet-5",
	"anthropic/claude-opus-5",
	"anthropic/claude-opus-4.7",
	"anthropic/claude-opus-4.6",
	"anthropic/claude-haiku-4.5",
	"anthropic/claude-fable-5",
	// OpenAI 原厂
	"openai/gpt-4o",
	"openai/gpt-4o-mini",
	"openai/gpt-5",
	"openai/gpt-5-mini",
	"openai/gpt-5.2",
	"openai/gpt-5.4",
	"openai/gpt-5.5",
	"openai/gpt-5.6-luna",
	"openai/gpt-5.6-sol",
	"openai/o1",
	"openai/o3",
	"openai/o3-mini",
	"openai/o4-mini",
	// DeepSeek 原厂
	"deepseek/deepseek-v4.1-flash",
	"deepseek/deepseek-v4-pro",
	"deepseek/deepseek-r1",
	"deepseek/deepseek-v3.2",
	// Google 原厂
	"google/gemini-2.5-pro",
	"google/gemini-2.5-flash",
	"google/gemini-3.8-flash",
	"google/gemini-3.5-flash",
	// 国内原厂
	"moonshotai/kimi-k3",
	"moonshotai/kimi-k2.7-code",
	"minimax/minimax-m3",
	"minimax/minimax-m2.5",
	"zai/glm-5",
	"zai/glm-4.7",
	"alibaba/qwen3.8-max",
	"alibaba/qwen3-coder",
	"spacexai/grok-4.5",
	"spacexai/grok-4.20-reasoning",
];

/**
 * Billing groups on production NewAPI (verified via /api/pricing usable_group).
 * 「官方」copy must stay vendor GPT/Claude only — never Vercel/Fireworks.
 */
export const FLOWSTOKEN_GROUPS = [
	{
		id: "default" as const,
		providerId: "flowstoken-default",
		labelZh: "普通组",
		tokenName: "FlowsToken-Desktop-普通",
		descriptionZh: "经济实用，主流高性价比模型",
		defaultModels: FLOWSTOKEN_DEFAULT_GROUP_MODELS,
	},
	{
		id: "smart" as const,
		providerId: "flowstoken-smart",
		labelZh: "智能组",
		tokenName: "FlowsToken-Desktop-智能",
		descriptionZh: "智能选模（Bestoo-Auto 自动分配最佳专家模型）",
		defaultModels: FLOWSTOKEN_SMART_GROUP_MODELS,
	},
	{
		id: "vip" as const,
		providerId: "flowstoken-official",
		labelZh: "官方组",
		tokenName: "FlowsToken-Desktop-官方",
		descriptionZh: "厂商官方模型（GPT / Claude 等），模型 ID 与厂商一致",
		defaultModels: FLOWSTOKEN_OFFICIAL_GROUP_MODELS,
	},
] as const;

export type FlowstokenGroupId = (typeof FLOWSTOKEN_GROUPS)[number]["id"];

/** Quota units per 1 USD on production (quota_per_unit from /api/status). */
export const FLOWSTOKEN_QUOTA_PER_USD = 500_000;
