// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSelectorView, type ModelSelectorViewProps } from "@vetta-org/theme-ui/chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

const labels: ModelSelectorViewProps["labels"] = {
	placeholder: "Choose model",
	searchPlaceholder: "Search models",
	clearSearch: "Clear search",
	noResults: "No models",
	noResultsHint: "Try another query",
	reasoningHeader: "Reasoning",
	modelHeader: "Models",
	cloudOnly: "Cloud",
	visionBadge: "Vision",
	defaultBadge: "Default",
	levelLabel: (value) => value,
};

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", ResizeObserverStub);
	HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ModelSelectorView", () => {
	it("opens, searches and selects without locking the surrounding document", async () => {
		const user = userEvent.setup();
		const onModelSelect = vi.fn();
		render(
			<ModelSelectorView
				selectedModel="provider/alpha"
				selectedOption={{
					key: "provider/alpha",
					provider: "provider",
					modelId: "alpha",
					displayName: "Alpha",
				}}
				menuLevels={[]}
				groups={[
					{
						provider: "provider",
						label: "Provider",
						models: [
							{
								key: "provider/alpha",
								provider: "provider",
								modelId: "alpha",
								displayName: "Alpha",
							},
							{
								key: "provider/beta",
								provider: "provider",
								modelId: "beta",
								displayName: "Beta",
							},
						],
					},
				]}
				labels={labels}
				onModelSelect={onModelSelect}
				onReasoningSelect={vi.fn()}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "Alpha" });
		await user.click(trigger);

		const search = await screen.findByRole("searchbox", { name: "Search models" });
		await waitFor(() => expect(document.activeElement).toBe(search));
		expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
		expect(document.body.style.pointerEvents).not.toBe("none");

		await user.type(search, "beta");
		expect(screen.queryByRole("menuitem", { name: "Alpha" })).toBeNull();
		await user.click(screen.getByRole("menuitem", { name: "Beta" }));

		expect(onModelSelect).toHaveBeenCalledWith("provider/beta");
		await waitFor(() => expect(screen.queryByRole("searchbox", { name: "Search models" })).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});

	it("shows FlowsToken official models by vendor with NEW badges and filters by vendor", async () => {
		const user = userEvent.setup();
		const onModelSelect = vi.fn();
		const official = (modelId: string, vendor: string, isNew = false) => ({
			key: `flowstoken-official/${modelId}`,
			provider: "flowstoken-official",
			modelId,
			displayName: modelId.slice(modelId.indexOf("/") + 1),
			vendor,
			isNew,
		});
		const models = [
			official("anthropic/claude-opus-5.5", "Anthropic", true),
			official("anthropic/claude-sonnet-4.6", "Anthropic"),
			official("openai/gpt-6-sol", "OpenAI", true),
			official("xai/grok-4.7", "xAI"),
		];
		render(
			<ModelSelectorView
				selectedModel={models[1].key}
				selectedOption={models[1]}
				menuLevels={[]}
				groups={[
					{
						provider: "flowstoken-smart",
						label: "FlowsToken 智能组",
						models: [{ key: "flowstoken-smart/Bestoo-Auto", provider: "flowstoken-smart", modelId: "Bestoo-Auto", displayName: "Bestoo-Auto" }],
					},
					{ provider: "flowstoken-official", label: "FlowsToken 官方组", models },
				]}
				labels={{ ...labels, newBadge: "NEW", allVendors: "All vendors" }}
				onModelSelect={onModelSelect}
				onReasoningSelect={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /claude-sonnet-4\.6/ }));
		const items = await screen.findAllByRole("menuitem");
		expect(items.map((item) => item.textContent)).toEqual([
			expect.stringContaining("claude-opus-5.5"),
			expect.stringContaining("claude-sonnet-4.6"),
			expect.stringContaining("gpt-6-sol"),
			expect.stringContaining("grok-4.7"),
		]);
		expect(screen.getAllByText("NEW")).toHaveLength(2);
		// vendor subheaders appear once per vendor, in the host's order
		const list = items[0].parentElement?.parentElement as HTMLElement;
		expect(list.textContent?.indexOf("Anthropic")).toBeLessThan(list.textContent?.indexOf("OpenAI") ?? -1);

		await user.click(screen.getByRole("button", { name: "xAI" }));
		expect(screen.queryByRole("menuitem", { name: /claude-opus-5\.5/ })).toBeNull();
		await user.click(screen.getByRole("menuitem", { name: /grok-4\.7/ }));
		expect(onModelSelect).toHaveBeenCalledWith("flowstoken-official/xai/grok-4.7");
	});
});
