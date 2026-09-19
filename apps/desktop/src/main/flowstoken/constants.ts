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
		descriptionZh: "经济实用，双通道高可用",
		defaultModels: [] as string[],
	},
	{
		id: "smart" as const,
		providerId: "flowstoken-smart",
		labelZh: "智能组",
		tokenName: "FlowsToken-Desktop-智能",
		descriptionZh: "智能选模（Bestoo-Auto）",
		defaultModels: ["Bestoo-Auto"],
	},
	{
		id: "vip" as const,
		providerId: "flowstoken-official",
		labelZh: "官方组",
		tokenName: "FlowsToken-Desktop-官方",
		descriptionZh: "厂商官方模型（GPT / Claude 等），模型 ID 与厂商一致",
		defaultModels: [] as string[],
	},
] as const;

export type FlowstokenGroupId = (typeof FLOWSTOKEN_GROUPS)[number]["id"];

/** Quota units per 1 USD on production (quota_per_unit from /api/status). */
export const FLOWSTOKEN_QUOTA_PER_USD = 500_000;
