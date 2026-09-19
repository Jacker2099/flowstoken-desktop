/**
 * FlowsToken Desktop provider presets (additive overlay).
 * Keys are never embedded — users paste API keys into the OS credential vault via settings.
 * See branding/flowstoken/SECURITY.md and branding/flowstoken/providers.json.
 */
import type { PresetProviderDef } from "./catalog.js";

const FT_BASE = "https://www.flowstoken.com/v1";

/** OpenAI-compatible chat models on FlowsToken NewAPI; drop obvious non-chat ids. */
const NON_CHAT = /embedding|embed|whisper|tts|audio|realtime|moderation|dall-e|image|transcribe|rerank|vision-ocr/i;

function isFlowsTokenChatModel(id: string): boolean {
	return Boolean(id?.trim()) && !NON_CHAT.test(id);
}

/**
 * Three billing groups share one OpenAI-compatible base URL.
 * Users adopt a preset, paste their FlowsToken API key (created in the web console),
 * then pick models — 智能组 should use `bestoo-auto`.
 */
export const FLOWSTOKEN_PRESET_PROVIDERS: readonly PresetProviderDef[] = [
	{
		id: "flowstoken-normal",
		displayName: "FlowsToken 普通组",
		icon: "openai",
		api: "openai-completions",
		baseUrl: FT_BASE,
		fetcher: "openai-compatible",
		isChatModel: isFlowsTokenChatModel,
	},
	{
		id: "flowstoken-smart",
		displayName: "FlowsToken 智能组",
		icon: "openai",
		api: "openai-completions",
		baseUrl: FT_BASE,
		fetcher: "openai-compatible",
		isChatModel: isFlowsTokenChatModel,
	},
	{
		id: "flowstoken-official",
		displayName: "FlowsToken 官方组",
		icon: "openai",
		api: "openai-completions",
		baseUrl: FT_BASE,
		fetcher: "openai-compatible",
		isChatModel: isFlowsTokenChatModel,
	},
];
