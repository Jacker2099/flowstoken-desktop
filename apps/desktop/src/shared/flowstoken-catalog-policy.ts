/** Catalog identity policy shared by main and renderer. No transport or credentials. */
export const FLOWSTOKEN_MODEL_KINDS = ["chat", "image", "embedding", "rerank", "audio", "video"] as const;
export type FlowstokenModelKind = (typeof FLOWSTOKEN_MODEL_KINDS)[number];
export const FLOWSTOKEN_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type FlowstokenReasoningLevel = (typeof FLOWSTOKEN_REASONING_LEVELS)[number];

export const FLOWSTOKEN_LEGACY_PROVIDER_IDS = {
	default: "flowstoken-default",
	smart: "flowstoken-smart",
	vip: "flowstoken-official",
} as const;

export function isValidBillingGroupId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

export function providerIdForGroup(id: string): string {
	if (!isValidBillingGroupId(id)) throw new Error("Invalid FlowsToken billing group ID");
	if (Object.hasOwn(FLOWSTOKEN_LEGACY_PROVIDER_IDS, id))
		return FLOWSTOKEN_LEGACY_PROVIDER_IDS[id as keyof typeof FLOWSTOKEN_LEGACY_PROVIDER_IDS];
	return `flowstoken-group-${id}`;
}

export function canonicalFlowstokenProviderId(providerId: string): string {
	return providerId === "flowstoken-normal" ? FLOWSTOKEN_LEGACY_PROVIDER_IDS.default : providerId;
}

export function isManagedFlowstokenProviderId(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value === "flowstoken-normal" || Object.values(FLOWSTOKEN_LEGACY_PROVIDER_IDS).some((id) => id === value))
		return true;
	const prefix = "flowstoken-group-";
	const group = value.startsWith(prefix) ? value.slice(prefix.length) : "";
	return isValidBillingGroupId(group) && providerIdForGroup(group) === value;
}
