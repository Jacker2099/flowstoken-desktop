import { describe, expect, it } from "vitest";
import { NEW_MODEL_WINDOW_MS, orderGroupModels, type PricingModel } from "./model-order.js";

const vendors = [
	{ id: 1, name: "OpenAI" },
	{ id: 2, name: "Anthropic" },
	{ id: 3, name: "DeepSeek" },
	{ id: 4, name: "Google" },
	{ id: 5, name: "智谱" },
	{ id: 6, name: "Mistral" },
	{ id: 7, name: "Meta" },
];
const NOW = Date.UTC(2026, 8, 29);
const day = 24 * 60 * 60;
const at = (daysAgo: number) => Math.floor(NOW / 1000) - daysAgo * day;

function m(
	model_name: string,
	vendor_id: number,
	model_ratio: number,
	extra: Partial<PricingModel> = {},
): PricingModel {
	return {
		model_name,
		vendor_id,
		model_ratio,
		completion_ratio: 5,
		quota_type: 0,
		supported_endpoint_types: ["openai"],
		...extra,
	};
}

describe("orderGroupModels", () => {
	it("puts foreign frontier vendors first, Chinese vendors after; newest period first, priciest first inside it", () => {
		const models = [
			m("deepseek/deepseek-v4.1-flash", 3, 0.1),
			m("zai/glm-5.3", 5, 0.7),
			m("mistral/mistral-large-3", 6, 1),
			m("openai/gpt-5.5", 1, 2.5),
			m("openai/gpt-6-luna", 1, 0.05),
			m("openai/gpt-6-astra", 1, 5),
			m("anthropic/claude-haiku-4.5", 2, 0.5),
			m("anthropic/claude-opus-4", 2, 7.5),
			m("anthropic/claude-sonnet-5.5", 2, 1.5),
			m("anthropic/claude-opus-5.5", 2, 2.5),
			m("google/gemini-3.8-flash", 4, 0.2),
		];
		const released = {
			"anthropic/claude-opus-5.5": at(5),
			"anthropic/claude-sonnet-5.5": at(5),
			"anthropic/claude-haiku-4.5": at(200),
			"anthropic/claude-opus-4": at(480),
			"openai/gpt-6-astra": at(10),
			"openai/gpt-6-luna": at(10),
			"openai/gpt-5.5": at(120),
		};
		const ordered = orderGroupModels(models, vendors, released, NOW);
		expect(ordered.map((x) => x.id)).toEqual([
			"anthropic/claude-opus-5.5",
			"anthropic/claude-sonnet-5.5",
			"anthropic/claude-haiku-4.5",
			// the old flagship is dearer but from an older period
			"anthropic/claude-opus-4",
			"openai/gpt-6-astra",
			"openai/gpt-6-luna",
			"openai/gpt-5.5",
			"google/gemini-3.8-flash",
			"mistral/mistral-large-3",
			"deepseek/deepseek-v4.1-flash",
			"zai/glm-5.3",
		]);
		expect(ordered[0]).toMatchObject({ name: "claude-opus-5.5", vendor: "Anthropic", isNew: true });
		expect(ordered.at(-1)).toMatchObject({ name: "glm-5.3", vendor: "智谱", isNew: false });
	});

	it("does not compare version numbers across product lines of one vendor", () => {
		const models = [m("meta/llama-4-maverick", 7, 0.3), m("meta/muse-spark-1.3", 7, 0.3)];
		const released = { "meta/llama-4-maverick": at(500), "meta/muse-spark-1.3": at(8) };
		expect(orderGroupModels(models, vendors, released, NOW).map((x) => x.id)).toEqual([
			"meta/muse-spark-1.3",
			"meta/llama-4-maverick",
		]);
	});

	it("marks models released within the last 30 days as new, never future or undated ones", () => {
		const models = [m("gpt-6-sol", 1, 1), m("gpt-5.5", 1, 1), m("gpt-7", 1, 1), m("gpt-5.6-sol", 1, 1)];
		const released = { "gpt-6-sol": at(3), "gpt-5.5": at(45), "gpt-7": at(-2) };
		const isNew = Object.fromEntries(orderGroupModels(models, vendors, released, NOW).map((x) => [x.id, x.isNew]));
		expect(isNew).toEqual({ "gpt-6-sol": true, "gpt-5.5": false, "gpt-7": false, "gpt-5.6-sol": false });
		expect(NEW_MODEL_WINDOW_MS).toBe(30 * day * 1000);
	});

	it("keeps image models at the end of their vendor and groups unknown vendors last", () => {
		const models = [
			m("gpt-image-2", 1, 0, { quota_type: 1, supported_endpoint_types: ["image-generation", "openai"] }),
			m("gpt-5.6-terra", 1, 0.5),
			m("mystery-model", 99, 9),
			m("claude-sonnet-4-6", 2, 1.5),
		];
		expect(orderGroupModels(models, vendors, {}, NOW).map((x) => [x.id, x.vendor])).toEqual([
			["claude-sonnet-4-6", "Anthropic"],
			["gpt-5.6-terra", "OpenAI"],
			["gpt-image-2", "OpenAI"],
			["mystery-model", "其他"],
		]);
	});
});
