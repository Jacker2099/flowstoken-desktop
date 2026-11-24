/**
 * Design Mode 元素拾取：注入 guest webview 的拾取脚本与结果类型。
 *
 * 脚本在 guest 里自运行：hover 高亮、点击捕获后写入 window.__vettaPickedElement
 * 并自行卸载监听；宿主侧轮询读取该变量。脚本必须是自包含字符串——
 * executeJavaScript 在 guest 上下文执行，不能引用宿主任何闭包。
 */

export interface PickedElement {
	readonly url: string;
	readonly title: string;
	readonly tagName: string;
	readonly id: string;
	readonly classes: readonly string[];
	readonly selector: string;
	/** 截取后的 outerHTML（上限见脚本内 HTML_LIMIT）。 */
	readonly html: string;
	/** 关键计算样式子集：布局/排版/颜色/间距。 */
	readonly styles: Readonly<Record<string, string>>;
	readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export const PICKED_ELEMENT_GLOBAL = "__vettaPickedElement";

/** 生成一条尽量短且稳定的 CSS 选择器（id 优先，否则沿层级 class 路径）。 */
export function buildSelectorSummary(tagName: string, id: string, classes: readonly string[]): string {
	if (id) return `#${id}`;
	const classPart = classes
		.slice(0, 3)
		.map((name) => `.${name}`)
		.join("");
	return `${tagName.toLowerCase()}${classPart}`;
}

/**
 * 注入脚本：返回值即字符串化后的脚本本体（不依赖任何外部符号）。
 * 防护：重复注入时先清理旧监听；点击捕获后自动卸载。
 */
export function elementPickerInjectScript(): string {
	const globalKey = JSON.stringify(PICKED_ELEMENT_GLOBAL);
	return `(() => {
		const GLOBAL_KEY = ${globalKey};
		const HTML_LIMIT = 3000;
		const STYLE_PROPS = [
			"display", "position", "box-sizing",
			"width", "height", "margin", "padding",
			"color", "background-color", "font-family", "font-size", "font-weight", "line-height",
			"border", "border-radius", "box-shadow",
			"flex-direction", "justify-content", "align-items", "gap", "grid-template-columns",
		];
		if (window.__vettaPickerCleanup) { window.__vettaPickerCleanup(); }
		window[GLOBAL_KEY] = null;

		const overlay = document.createElement("div");
		overlay.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #4c9aff;background:rgba(76,154,255,0.12);display:none;transition:all 60ms ease;";
		document.documentElement.appendChild(overlay);

		let current = null;
		const onMove = (event) => {
			const target = event.target;
			if (!(target instanceof Element) || target === overlay) return;
			current = target;
			const rect = target.getBoundingClientRect();
			overlay.style.display = "block";
			overlay.style.left = rect.left + "px";
			overlay.style.top = rect.top + "px";
			overlay.style.width = rect.width + "px";
			overlay.style.height = rect.height + "px";
		};
		const buildSelector = (el) => {
			if (el.id) return "#" + el.id;
			const parts = [];
			let node = el;
			while (node && node !== document.body && parts.length < 4) {
				let part = node.tagName.toLowerCase();
				if (node.classList.length > 0) part += "." + Array.from(node.classList).slice(0, 2).join(".");
				parts.unshift(part);
				node = node.parentElement;
			}
			return parts.join(" > ");
		};
		const onClick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			const el = current;
			if (!el) return;
			const computed = getComputedStyle(el);
			const styles = {};
			for (const prop of STYLE_PROPS) {
				const value = computed.getPropertyValue(prop);
				if (value) styles[prop] = value;
			}
			const rect = el.getBoundingClientRect();
			let html = el.outerHTML;
			if (html.length > HTML_LIMIT) html = html.slice(0, HTML_LIMIT) + "\\n<!-- truncated -->";
			window[GLOBAL_KEY] = {
				url: location.href,
				title: document.title,
				tagName: el.tagName,
				id: el.id || "",
				classes: Array.from(el.classList),
				selector: buildSelector(el),
				html,
				styles,
				rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			};
			cleanup();
		};
		const onKeydown = (event) => {
			if (event.key === "Escape") cleanup();
		};
		function cleanup() {
			document.removeEventListener("mousemove", onMove, true);
			document.removeEventListener("click", onClick, true);
			document.removeEventListener("keydown", onKeydown, true);
			overlay.remove();
			window.__vettaPickerCleanup = null;
		}
		window.__vettaPickerCleanup = cleanup;
		document.addEventListener("mousemove", onMove, true);
		document.addEventListener("click", onClick, true);
		document.addEventListener("keydown", onKeydown, true);
		return true;
	})()`;
}

/** 宿主轮询脚本：读取捕获结果（无则为 null），读后即清，避免重复消费。 */
export function elementPickerPollScript(): string {
	const globalKey = JSON.stringify(PICKED_ELEMENT_GLOBAL);
	return `(() => { const v = window[${globalKey}]; if (v) window[${globalKey}] = null; return v; })()`;
}

/** 卸载脚本：用户手动关闭拾取模式时调用，清掉监听与高亮。 */
export function elementPickerCancelScript(): string {
	return `(() => { if (window.__vettaPickerCleanup) window.__vettaPickerCleanup(); return true; })()`;
}

/** 把捕获结果格式化为送入对话的 markdown 引用块。 */
export function formatPickedElementForPrompt(element: PickedElement): string {
	const styleLines = Object.entries(element.styles)
		.map(([prop, value]) => `  ${prop}: ${value};`)
		.join("\n");
	return [
		`[Element picked from ${element.title || element.url}]`,
		`URL: ${element.url}`,
		`Selector: ${element.selector}`,
		"",
		"HTML:",
		"```html",
		element.html,
		"```",
		"",
		"Computed styles:",
		"```css",
		styleLines,
		"```",
	].join("\n");
}
