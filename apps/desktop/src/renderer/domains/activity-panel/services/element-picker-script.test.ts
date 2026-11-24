// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSelectorSummary,
	elementPickerInjectScript,
	formatPickedElementForPrompt,
	type PickedElement,
} from "./element-picker-script";

function inject(): void {
	// biome-ignore lint/security/noGlobalEval: 测试的正是注入脚本本体，必须在 jsdom 里真实执行。
	window.eval(elementPickerInjectScript());
}

function click(el: Element): void {
	el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
	el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("element picker injected script", () => {
	afterEach(() => {
		document.body.innerHTML = "";
		delete (window as unknown as Record<string, unknown>).__vettaPickedElement;
		delete (window as unknown as Record<string, unknown>).__vettaPickerCleanup;
	});

	it("captures the clicked element's identity, html, styles and rect into the global", () => {
		document.body.innerHTML = `<div class="wrap"><button id="cta" class="btn primary">Go</button></div>`;
		inject();
		const button = document.querySelector("#cta") as Element;
		click(button);

		const picked = (window as unknown as Record<string, unknown>).__vettaPickedElement as PickedElement | null;
		expect(picked).not.toBeNull();
		expect(picked?.tagName).toBe("BUTTON");
		expect(picked?.id).toBe("cta");
		expect(picked?.classes).toEqual(["btn", "primary"]);
		expect(picked?.selector).toBe("#cta");
		expect(picked?.html).toContain(">Go</button>");
		expect(picked?.styles.display).toBeDefined();
		expect(picked?.rect.width).toBeDefined();
	});

	it("prevents the click default so links are not followed while picking", () => {
		document.body.innerHTML = `<a id="link" href="https://example.com">x</a>`;
		inject();
		const link = document.querySelector("#link") as Element;
		const event = new MouseEvent("click", { bubbles: true, cancelable: true });
		link.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
		link.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});

	it("unloads after capture so a second click writes nothing new", () => {
		document.body.innerHTML = `<button id="a">1</button><button id="b">2</button>`;
		inject();
		click(document.querySelector("#a") as Element);
		const first = (window as unknown as Record<string, unknown>).__vettaPickedElement as PickedElement;
		(window as unknown as Record<string, unknown>).__vettaPickedElement = null;
		click(document.querySelector("#b") as Element);
		expect((window as unknown as Record<string, unknown>).__vettaPickedElement).toBeNull();
		expect(first.id).toBe("a");
	});

	it("truncates very large outerHTML", () => {
		const big = `<div id="big">${"x".repeat(5000)}</div>`;
		document.body.innerHTML = big;
		inject();
		click(document.querySelector("#big") as Element);
		const picked = (window as unknown as Record<string, unknown>).__vettaPickedElement as PickedElement;
		expect(picked.html.length).toBeLessThan(3200);
		expect(picked.html).toContain("truncated");
	});
});

describe("buildSelectorSummary", () => {
	it("prefers id, falls back to tag+classes", () => {
		expect(buildSelectorSummary("BUTTON", "cta", ["a"])).toBe("#cta");
		expect(buildSelectorSummary("div", "", ["wrap", "x", "y", "z"])).toBe("div.wrap.x.y");
		expect(buildSelectorSummary("span", "", [])).toBe("span");
	});
});

describe("formatPickedElementForPrompt", () => {
	it("renders a markdown block with url, selector, html and styles", () => {
		const text = formatPickedElementForPrompt({
			url: "https://example.com/page",
			title: "Example",
			tagName: "BUTTON",
			id: "cta",
			classes: ["btn"],
			selector: "#cta",
			html: "<button>Go</button>",
			styles: { display: "block", color: "rgb(1, 2, 3)" },
			rect: { x: 1, y: 2, width: 3, height: 4 },
		});
		expect(text).toContain("https://example.com/page");
		expect(text).toContain("Selector: #cta");
		expect(text).toContain("```html");
		expect(text).toContain("<button>Go</button>");
		expect(text).toContain("color: rgb(1, 2, 3);");
	});
});
