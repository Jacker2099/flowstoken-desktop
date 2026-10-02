// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSelectorView, type ModelSelectorViewProps } from "@vetta-org/theme-ui/chat";
import { DetailDrawer } from "@vetta-org/theme-ui/overlays";
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
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(() => true),
	}));
	HTMLElement.prototype.scrollIntoView = vi.fn();
	HTMLElement.prototype.setPointerCapture = vi.fn();
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
		const official = (modelId: string, vendorId: string, vendor: string, vendorIcon?: string, isNew = false) => ({
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
		expect(chips.slice(0, 3)).toEqual(["All vendors", "Anthropic2", "OpenAI1"]);
		expect(chips[3]).toContain("xAI");
		const anthropicImg = screen.getByRole("button", { name: /Anthropic/ }).querySelector("img");
		expect(anthropicImg?.getAttribute("src")).toBe("https://img.test/claude.svg");
		expect(screen.getByRole("button", { name: /xAI/ }).querySelector("img")).toBeNull();
		const xaiChip = screen.getByRole("button", { name: /xAI/ });
		expect(xaiChip.querySelector("img")).toBeNull();
		expect(xaiChip.querySelector("[aria-hidden=true]")?.textContent).toBe("x");

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

it("preserves the tab being browsed during catalog refresh and follows explicit selection or removed tabs", async () => {
	const user = userEvent.setup();
	const smart = { key: "smart/auto", provider: "smart", modelId: "auto", displayName: "Auto" };
	const official = { key: "official/claude", provider: "official", modelId: "claude", displayName: "Claude" };
	const props: ModelSelectorViewProps = {
		selectedModel: smart.key,
		selectedOption: smart,
		menuLevels: [],
		labels,
		groups: [
			{ provider: "smart", label: "Smart provider", models: [smart] },
			{ provider: "official", label: "Official provider", models: [official] },
		],
		tabs: [
			{ id: "smart", label: "Smart", providers: ["smart"] },
			{ id: "vip", label: "Official", providers: ["official"] },
			{ id: "all", label: "All", providers: [] },
		],
		initialTab: "smart",
		onModelSelect: vi.fn(),
		onReasoningSelect: vi.fn(),
	};
	const { rerender } = render(<ModelSelectorView {...props} />);
	await user.click(screen.getByRole("button", { name: "Auto" }));
	await user.click(await screen.findByRole("button", { name: "Official" }));
	expect(screen.getByRole("menuitem", { name: "Claude" })).toBeTruthy();

	// Fetching a fresh catalog recreates its arrays without changing the selected model.
	rerender(
		<ModelSelectorView
			{...props}
			tabs={props.tabs?.map((tab) => ({ ...tab }))}
			groups={props.groups.map((group) => ({ ...group, models: [...group.models] }))}
		/>,
	);
	expect(screen.getByRole("menuitem", { name: "Claude" })).toBeTruthy();
	expect(screen.queryByRole("menuitem", { name: "Auto" })).toBeNull();

	// An explicit selection still selects the corresponding tab, as before.
	rerender(<ModelSelectorView {...props} selectedModel={official.key} selectedOption={official} initialTab="vip" />);
	rerender(<ModelSelectorView {...props} />);
	await waitFor(() => expect(screen.getByRole("menuitem", { name: "Auto" })).toBeTruthy());

	await user.click(screen.getByRole("button", { name: "Official" }));
	rerender(<ModelSelectorView {...props} tabs={props.tabs?.filter((tab) => tab.id !== "vip")} />);
	await waitFor(() => expect(screen.getByRole("menuitem", { name: "Auto" })).toBeTruthy());
});

describe("ModelSelectorView upstream controls", () => {
	it("supports a controlled empty selection and a disabled trigger", async () => {
		const user = userEvent.setup();
		const onEmptySelect = vi.fn();
		const { rerender } = render(
			<ModelSelectorView
				ariaLabel="Member model"
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
						],
					},
				]}
				labels={labels}
				emptyOption={{ label: "Follow conversation default", onSelect: onEmptySelect }}
				onModelSelect={vi.fn()}
				onReasoningSelect={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Member model" }));
		await user.click(await screen.findByRole("menuitem", { name: "Follow conversation default" }));
		expect(onEmptySelect).toHaveBeenCalledOnce();

		rerender(
			<ModelSelectorView
				ariaLabel="Member model"
				disabled
				selectedModel="provider/alpha"
				selectedOption={{
					key: "provider/alpha",
					provider: "provider",
					modelId: "alpha",
					displayName: "Alpha",
				}}
				menuLevels={[]}
				groups={[]}
				labels={labels}
				onModelSelect={vi.fn()}
				onReasoningSelect={vi.fn()}
			/>,
		);

		const disabledTrigger = screen.getByRole("button", { name: "Member model" });
		expect(disabledTrigger).toHaveProperty("disabled", true);
		await user.click(disabledTrigger);
		expect(screen.queryByRole("searchbox", { name: "Search models" })).toBeNull();
	});

	it("keeps its scrollable menu inside a modal drawer's scroll boundary", async () => {
		render(
			<DetailDrawer open title="Team" onClose={vi.fn()}>
				<ModelSelectorView
					selectedOption={null}
					menuLevels={[]}
					groups={[
						{
							provider: "provider",
							label: "Provider",
							models: Array.from({ length: 30 }, (_, index) => ({
								key: `provider/model-${index}`,
								provider: "provider",
								modelId: `model-${index}`,
								displayName: `Model ${index}`,
							})),
						},
					]}
					labels={labels}
					onModelSelect={vi.fn()}
					onReasoningSelect={vi.fn()}
				/>
			</DetailDrawer>,
		);

		fireEvent.keyDown(screen.getByRole("button", { name: "Choose model" }), { key: "Enter" });
		const drawer = document.querySelector('[data-slot="drawer-content"]');
		const menu = document.querySelector('[data-slot="dropdown-menu-content"]');
		expect(drawer).not.toBeNull();
		expect(menu).not.toBeNull();
		expect(drawer?.contains(menu)).toBe(true);
	});
});

function compactProps(): ModelSelectorViewProps {
	const model = (provider: string, modelId: string, displayName: string, vendor = "Acme") => ({
		key: `${provider}/${modelId}`,
		provider,
		modelId,
		displayName,
		vendor,
		vendorId: vendor,
	});
	const alpha = model("group-a", "alpha", "Alpha");
	const beta = model("group-b", "beta", "Beta");
	return {
		selectedModel: alpha.key,
		selectedOption: alpha,
		menuLevels: [],
		labels,
		groups: [
			{ provider: "group-a", label: "First group", models: [alpha] },
			{ provider: "group-b", label: "Second group", models: [beta] },
		],
		tabs: [
			{ id: "a", label: "First", providers: ["group-a"], modelCount: 1 },
			{ id: "b", label: "Second", providers: ["group-b"], modelCount: 1 },
		],
		onModelSelect: vi.fn(),
		onReasoningSelect: vi.fn(),
	};
}

describe("compact catalog interactions", () => {
	it("cancels the pending initial scroll after the user chooses a vendor without letting a late frame steal focus", async () => {
		const callbacks: FrameRequestCallback[] = [];
		const cancel = vi.fn();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callbacks.push(callback);
			return callbacks.length;
		});
		vi.stubGlobal("cancelAnimationFrame", cancel);
		const user = userEvent.setup();
		const props = compactProps();
		render(<ModelSelectorView {...props} vendorBarByTab={{ a: [{ id: "Acme", name: "Acme" }] }} />);
		await user.click(screen.getByRole("button", { name: "Alpha" }));
		const vendor = await screen.findByRole("button", { name: "Acme" });
		await user.click(vendor);
		const target = Array.from(document.querySelectorAll<HTMLElement>("[data-model-vendor-section]")).find(
			(node) => node.dataset.vendorId === "Acme",
		);
		expect(cancel).toHaveBeenCalled();
		const pending = [...callbacks];
		for (const callback of pending) callback(16);
		expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.instances.at(-1)).toBe(target);
		expect(document.activeElement).toBe(vendor);
	});
	it("refreshes through the host once, reports busy and cache status, and retains the selection on failure", async () => {
		const user = userEvent.setup();
		const props = compactProps();
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const refresh = vi.fn(() => pending);
		const refreshLabels = {
			...labels,
			syncCatalog: "Refresh catalog",
			cached: "Using last saved catalog",
			refreshFailed: "Could not refresh; current models kept",
		};
		const { rerender } = render(
			<ModelSelectorView {...props} labels={refreshLabels} onCatalogRefresh={refresh} catalogStatus="cache" />,
		);
		await user.click(screen.getByRole("button", { name: "Alpha" }));
		const button = await screen.findByRole("button", { name: "Refresh catalog" });
		expect(button.title).toContain("Using last saved catalog");
		await user.click(button);
		expect(button.getAttribute("aria-busy")).toBe("true");
		expect(button).toHaveProperty("disabled", true);
		await user.click(button);
		expect(refresh).toHaveBeenCalledOnce();
		finish();
		await waitFor(() => expect(button).toHaveProperty("disabled", false));
		expect(props.onModelSelect).not.toHaveBeenCalled();
		rerender(
			<ModelSelectorView
				{...props}
				labels={refreshLabels}
				onCatalogRefresh={() => Promise.reject(new Error("offline"))}
				catalogStatus="cache"
			/>,
		);
		await user.click(button);
		await waitFor(() => expect(button.title).toContain(refreshLabels.refreshFailed));
		expect(screen.getByRole("status").textContent).toBe(refreshLabels.refreshFailed);
		expect(props.onModelSelect).not.toHaveBeenCalled();
		expect(screen.getByRole("menuitem", { name: "Alpha" })).toBeTruthy();
	});

	it("handles valid prototype-like billing names without inventing inherited recommendation or vendor data", async () => {
		const user = userEvent.setup();
		const props = compactProps();
		render(
			<ModelSelectorView
				{...props}
				initialTab="constructor"
				tabs={[{ id: "constructor", label: "Constructor", providers: ["group-a"] }]}
				highlightByTab={{}}
				vendorBarByTab={{}}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Alpha" }));
		expect(await screen.findByRole("menuitem", { name: "Alpha" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /recommendation/ })).toBeNull();
	});
	it("filters a real all billing tab by providers rather than its reserved-looking name", async () => {
		const user = userEvent.setup();
		const props = compactProps();
		render(
			<ModelSelectorView
				{...props}
				initialTab="all"
				tabs={[
					{ id: "all", label: "Named all", providers: ["group-a"] },
					{ id: "__all__", label: "Every group", providers: [] },
				]}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Alpha" }));
		expect(await screen.findByRole("menuitem", { name: "Alpha" })).toBeTruthy();
		expect(screen.queryByRole("menuitem", { name: "Beta" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Every group" }));
		expect(screen.getByRole("menuitem", { name: "Beta" })).toBeTruthy();
	});

	it("keeps a valid browsing tab when the server adds and reorders groups, then safely follows its removal", async () => {
		const user = userEvent.setup();
		const props = compactProps();
		const { rerender } = render(<ModelSelectorView {...props} />);
		await user.click(screen.getByRole("button", { name: "Alpha" }));
		await user.click(await screen.findByRole("button", { name: "Second" }));
		const newTab = { id: "new", label: "Newly added", providers: ["group-a"] };
		rerender(<ModelSelectorView {...props} tabs={[newTab, ...props.tabs!]} />);
		expect(screen.getByRole("button", { name: "Second" }).getAttribute("aria-current")).toBe("page");
		expect(screen.getByRole("menuitem", { name: "Beta" })).toBeTruthy();
		rerender(<ModelSelectorView {...props} tabs={[newTab, props.tabs![0]]} />);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Newly added" }).getAttribute("aria-current")).toBe("page"),
		);
		expect(props.onModelSelect).not.toHaveBeenCalled();
	});

	it("provides short per-tab recommendations that are selectable with the keyboard", async () => {
		const user = userEvent.setup();
		const props = compactProps();
		render(
			<ModelSelectorView
				{...props}
				highlightByTab={{
					a: {
						tabId: "a",
						title: "First recommendation",
						modelKey: "group-a/alpha",
						description: "A short description",
					},
					b: { tabId: "b", title: "Second recommendation", modelKey: "group-b/beta" },
				}}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Alpha" }));
		const recommendation = await screen.findByRole("button", { name: /First recommendation/ });
		recommendation.focus();
		await user.keyboard("{Enter}");
		expect(props.onModelSelect).toHaveBeenCalledWith("group-a/alpha");
		await user.click(screen.getByRole("button", { name: "Second" }));
		expect(screen.queryByRole("button", { name: /First recommendation/ })).toBeNull();
		const next = screen.getByRole("button", { name: /Second recommendation/ });
		next.focus();
		await user.keyboard(" ");
		expect(props.onModelSelect).toHaveBeenLastCalledWith("group-b/beta");
	});

	it("searches vendor names and preserves full long names and model IDs in hover descriptions", async () => {
		const user = userEvent.setup();
		const props = compactProps();
		const longName = "Acme professional model with a deliberately very long descriptive name";
		const longId = "acme/version-with-a-deliberately-long-stable-api-identifier";
		const model = {
			...props.groups[0].models[0],
			displayName: longName,
			subtitle: longId,
			vendor: "Acme Research",
			supportsImage: true,
			isNew: true,
			tags: ["Official", "Featured"],
		};
		render(
			<ModelSelectorView
				{...props}
				selectedOption={model}
				groups={[{ ...props.groups[0], models: [model] }]}
				labels={{ ...labels, newBadge: "NEW" }}
			/>,
		);
		const trigger = screen.getByRole("button", { name: longName });
		expect(trigger.title).toBe(longName);
		await user.click(trigger);
		const search = await screen.findByRole("searchbox", { name: labels.searchPlaceholder });
		await user.type(search, "Research");
		const row = screen.getByRole("menuitem", { name: /Acme professional/ });
		expect(row.title).toContain(longName);
		expect(row.title).toContain(longId);
		expect(row.title).toContain("Official");
		expect(screen.queryByText("Official")).toBeNull();
		expect(screen.getByRole("img", { name: labels.visionBadge }).getAttribute("title")).toBe(labels.visionBadge);
	});

	it("matches unusual vendor IDs as data and resets the list position on every tab switch", async () => {
		const user = userEvent.setup();
		const props = compactProps();
		const id = 'vendor"] [data-model-key="unrelated';
		const model = { ...props.groups[0].models[0], vendorId: id };
		render(
			<ModelSelectorView
				{...props}
				groups={[{ ...props.groups[0], models: [model] }, props.groups[1]]}
				vendorBarByTab={{ a: [{ id, name: "Acme" }] }}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Alpha" }));
		const section = Array.from(document.querySelectorAll<HTMLElement>("[data-vendor-id]")).find(
			(element) => element.dataset.vendorId === id,
		)!;
		await user.click(screen.getByRole("button", { name: "Acme" }));
		expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.instances.at(-1)).toBe(section);
		const list = screen.getByRole("region", { name: labels.modelHeader });
		list.scrollTop = 120;
		await user.click(screen.getByRole("button", { name: "Second" }));
		expect(list.scrollTop).toBe(0);
	});

	it("keeps a removed selection unchanged, describes its status, and lets the user choose a replacement", async () => {
		const user = userEvent.setup();
		const props = compactProps();
		render(
			<ModelSelectorView
				{...props}
				selectedModel="group-a/retired"
				selectedOption={null}
				selectedUnavailable
				labels={{ ...labels, unavailableBadge: "Unavailable", unavailableHint: "Choose another available model" }}
			/>,
		);
		const trigger = screen.getByRole("button", { name: /retired/ });
		expect(trigger.title).toContain("Choose another available model");
		expect(trigger.getAttribute("aria-description")).toBe("Choose another available model");
		expect(props.onModelSelect).not.toHaveBeenCalled();
		await user.click(trigger);
		const search = await screen.findByRole("searchbox", { name: labels.searchPlaceholder });
		await user.type(search, "alpha");
		await user.keyboard("{ArrowDown}{Enter}");
		expect(props.onModelSelect).toHaveBeenCalledWith("group-a/alpha");
	});

	it("retains reasoning controls, default badges and host-provided price labels", async () => {
		const user = userEvent.setup();
		const props = compactProps();
		render(
			<ModelSelectorView
				{...props}
				currentLevel="low"
				menuLevels={["low", "high"]}
				defaultKey="group-a/alpha"
				labels={{ ...labels, multiplierLabel: () => "2×" }}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Alpha/ }));
		expect(await screen.findByText("2×")).toBeTruthy();
		expect(screen.getByText("Default")).toBeTruthy();
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: labels.searchPlaceholder })),
		);
		const reasoning = screen.getByRole("menuitem", { name: /Reasoning/ });
		reasoning.focus();
		await user.keyboard("{ArrowRight}");
		await screen.findByRole("menuitem", { name: "high" });
		await user.keyboard("{End}{Enter}");
		expect(props.onReasoningSelect).toHaveBeenCalledWith("high");
	});
});
