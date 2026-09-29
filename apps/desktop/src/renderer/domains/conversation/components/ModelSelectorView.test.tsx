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

	it("renders catalog tabs, vendor quick bar, sticky vendor sections and NEW badges", async () => {
		const user = userEvent.setup();
		const onModelSelect = vi.fn();
		const official = (
			modelId: string,
			vendorId: string,
			vendor: string,
			vendorIcon?: string,
			isNew = false,
		) => ({
			key: `flowstoken-official/${modelId}`,
			provider: "flowstoken-official",
			modelId,
			displayName: `Name ${modelId}`,
			subtitle: modelId,
			vendor,
			vendorId,
			vendorIcon,
			isNew,
		});
		const models = [
			official("anthropic/claude-opus-5.5", "anthropic", "Anthropic", "https://img.test/claude.svg", true),
			official("anthropic/claude-sonnet-4.6", "anthropic", "Anthropic", "https://img.test/claude.svg"),
			official("openai/gpt-6-sol", "openai", "OpenAI", "https://img.test/openai.svg", true),
			official("xai/grok-4.7", "xai", "xAI"),
		];
		const tabs = [
			{ id: "smart", label: "Smart", icon: "icon-x", providers: ["flowstoken-smart"] },
			{ id: "vip", label: "Official", icon: "icon-y", providers: ["flowstoken-official"] },
			{ id: "all", label: "All", providers: [] },
		];
		render(
			<ModelSelectorView
				selectedModel={models[1].key}
				selectedOption={models[1]}
				menuLevels={[]}
				groups={[
					{
						provider: "flowstoken-smart",
						label: "Smart",
						models: [
							{
								key: "flowstoken-smart/Bestoo-Auto",
								provider: "flowstoken-smart",
								modelId: "Bestoo-Auto",
								displayName: "Bestoo-Auto",
							},
						],
					},
					{ provider: "flowstoken-official", label: "Official", models },
				]}
				labels={{
					...labels,
					newBadge: "NEW",
					allVendors: "All vendors",
					recommendationSelected: "Selected",
					recommendationAction: "Click to use",
				}}
				tabs={tabs}
				initialTab="smart"
				highlight={{
					tabId: "smart",
					title: "Bestoo-Auto smart routing",
					badge: "Recommended",
					description: "Picks the best model",
					modelKey: "flowstoken-smart/Bestoo-Auto",
				}}
				vendorBarByTab={{
					vip: [
						{ id: "anthropic", name: "Anthropic", iconUrl: "https://img.test/claude.svg", count: 2 },
						{ id: "openai", name: "OpenAI", iconUrl: "https://img.test/openai.svg", mono: true, count: 1 },
						{ id: "xai", name: "xAI", count: 1 },
					],
				}}
				onModelSelect={onModelSelect}
				onReasoningSelect={vi.fn()}
			/>,
		);

		// Opens on the smart tab with the catalog-driven recommendation card.
		await user.click(screen.getByRole("button", { name: /claude-sonnet-4\.6/ }));
		expect(await screen.findByText("Bestoo-Auto smart routing")).toBeTruthy();
		expect(screen.getByText("Recommended")).toBeTruthy();
		expect(screen.getByText("Click to use")).toBeTruthy();
		await user.click(screen.getByText("Bestoo-Auto smart routing"));
		expect(onModelSelect).toHaveBeenCalledWith("flowstoken-smart/Bestoo-Auto");

		// Official tab: vendor chips in catalog order, logo imgs and initial fallback.
		await user.click(screen.getByRole("button", { name: "Official" }));
		const chips = screen
			.getAllByRole("button")
			.filter((b) => b.getAttribute("aria-pressed") !== null)
			.map((b) => b.textContent);
		expect(chips.slice(0, 3)).toEqual(["All vendors", "Anthropic", "OpenAI"]);
		expect(chips[3]).toContain("xAI");
		const anthropicImg = screen.getByRole("button", { name: /Anthropic/ }).querySelector("img");
		expect(anthropicImg?.getAttribute("src")).toBe("https://img.test/claude.svg");
		expect(screen.getByRole("button", { name: /xAI/ }).querySelector("img")).toBeNull();
		const xaiChip = screen.getByRole("button", { name: /xAI/ });
		expect(xaiChip.querySelector("img")).toBeNull();
		expect(xaiChip.querySelector(".rounded-full")).toBeTruthy();

		// Chip click scrolls to the matching vendor section without filtering rows.
		await user.click(screen.getByRole("button", { name: /^OpenAI/ }));
		expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
		const section = document.querySelector('[data-vendor-id="openai"]');
		expect(section?.textContent).toContain("OpenAI");
		expect(screen.getAllByRole("menuitem")).toHaveLength(4);

		// Rows show catalog display name plus the id subtitle and NEW badges.
		expect(screen.getByText("Name anthropic/claude-opus-5.5")).toBeTruthy();
		expect(screen.getByText("anthropic/claude-opus-5.5")).toBeTruthy();
		expect(screen.getAllByText("NEW")).toHaveLength(2);

		await user.click(screen.getByRole("menuitem", { name: /grok-4\.7/ }));
		expect(onModelSelect).toHaveBeenCalledWith("flowstoken-official/xai/grok-4.7");
	});
});
