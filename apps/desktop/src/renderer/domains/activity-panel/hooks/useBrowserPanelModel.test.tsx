// @vitest-environment jsdom
import { resolvedThemeAtom } from "@shared/store/atoms";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { MutableRefObject, PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityPanelContextProvider } from "../registry/context";
import { useBrowserPanelModel } from "./useBrowserPanelModel";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const pickerMocks = vi.hoisted(() => ({
	// 组合器是用户可见终点：mocks 把调用累积成状态，断言读最终内容而不是调用本身。
	composerImages: [] as string[],
	composerText: [] as string[],
	focused: false as boolean,
	insertImageToken: vi.fn((path: string) => {
		pickerMocks.composerImages.push(path);
	}),
	insertPlainText: vi.fn((text: string) => {
		pickerMocks.composerText.push(text);
	}),
	focusInputEditor: vi.fn(() => {
		pickerMocks.focused = true;
	}),
	// 截图路径由入参 rect 派生：组合器里出现派生路径即证明 rect 从拾取消息正确流经截图边界。
	captureElement: vi.fn(async (_id: number, rect: { width: number; height: number }) => ({
		path: `/tmp/element-${rect.width}x${rect.height}.png`,
		width: 100,
		height: 50,
	})),
}));

vi.mock("@domains/conversation/components/input-bar/editor/inputEditorHandle", () => ({
	insertImageToken: pickerMocks.insertImageToken,
	insertPlainText: pickerMocks.insertPlainText,
	focusInputEditor: pickerMocks.focusInputEditor,
}));

interface FakeGuest {
	insertCSS: (css: string) => Promise<string>;
	removeInsertedCSS: (key: string) => Promise<void>;
}

/** renderHook 不会把 props 传给 wrapper，切工作空间靠这个可变值 + rerender 驱动。 */
let currentWorkspaceId = "/work/project";

function setup() {
	const store = createStore();
	currentWorkspaceId = "/work/project";
	function Wrapper({ children }: PropsWithChildren) {
		return (
			<Provider store={store}>
				<ActivityPanelContextProvider
					value={{
						workspace: { id: currentWorkspaceId, cwd: currentWorkspaceId, runtimeIds: [] },
						knowledgeHistory: false,
					}}
				>
					{children}
				</ActivityPanelContextProvider>
			</Provider>
		);
	}
	const hook = renderHook(useBrowserPanelModel, { wrapper: Wrapper });
	const switchWorkspace = (workspaceId: string): void => {
		currentWorkspaceId = workspaceId;
		hook.rerender();
	};
	return { store, switchWorkspace, ...hook };
}

function fakeGuest(key: string): FakeGuest & HTMLElement {
	return {
		insertCSS: vi.fn(async () => key),
		removeInsertedCSS: vi.fn(async () => undefined),
	} as unknown as FakeGuest & HTMLElement;
}

function attachGuest(model: { webviewRef: unknown }, guest: HTMLElement): void {
	(model.webviewRef as MutableRefObject<HTMLElement | null>).current = guest;
}

async function flushInjection(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

afterEach(cleanup);

describe("browser panel theme injection", () => {
	// guest 是独立文档，宿主的 color-scheme 传不进去；不注入就会在深色主题下出现浅色滚动条。
	it("injects the resolved theme into the guest and replaces the previous stylesheet", async () => {
		const { store, result } = setup();
		const guest = fakeGuest("key-light");
		attachGuest(result.current, guest);

		// 产品默认浅色：先切深色，保证与初值不同、必定触发主题 effect。
		act(() => store.set(resolvedThemeAtom, "dark"));
		await flushInjection();
		expect(guest.insertCSS).toHaveBeenCalledWith(":root { color-scheme: dark; }");

		act(() => store.set(resolvedThemeAtom, "light"));
		await flushInjection();
		expect(guest.insertCSS).toHaveBeenLastCalledWith(":root { color-scheme: light; }");
		expect(guest.removeInsertedCSS).toHaveBeenCalledWith("key-light");
	});

	// 重新导航会拿到新文档，此前注入的样式随旧文档失效，必须重新注入。
	it("re-injects on every dom-ready of the guest", async () => {
		const { store, result, switchWorkspace } = setup();
		act(() => store.set(resolvedThemeAtom, "dark"));
		const listeners = new Map<string, () => void>();
		const guest = {
			...fakeGuest("key-dark"),
			addEventListener: (type: string, handler: () => void) => listeners.set(type, handler),
			removeEventListener: (type: string) => listeners.delete(type),
		} as unknown as FakeGuest & HTMLElement;
		attachGuest(result.current, guest);
		// webview 在挂载时还不存在，切工作空间让绑定 effect 重跑并挂到当前 guest 上。
		act(() => switchWorkspace("/work/other"));
		listeners.clear();
		act(() => switchWorkspace("/work/third"));

		act(() => listeners.get("dom-ready")?.());
		await flushInjection();
		expect(guest.insertCSS).toHaveBeenCalledWith(":root { color-scheme: dark; }");
	});
});

describe("browser panel element picker", () => {
	function fakePickGuest(pickedElement: unknown) {
		const calls: string[] = [];
		return {
			calls,
			guest: {
				insertCSS: vi.fn(async () => "key"),
				removeInsertedCSS: vi.fn(async () => undefined),
				getWebContentsId: vi.fn(() => 42),
				executeJavaScript: vi.fn(async (code: string) => {
					calls.push(code);
					// 轮询脚本很短且读取全局变量；注入脚本很长。用长度与内容区分。
					if (code.length < 200 && code.includes("__vettaPickedElement")) return pickedElement;
					return true;
				}),
			} as unknown as HTMLElement,
		};
	}

	function setupCaptureApi() {
		const vetta = { browser: { captureElement: pickerMocks.captureElement } };
		Object.defineProperty(window, "vetta", { value: vetta, configurable: true, writable: true });
	}

	const picked = {
		url: "https://example.com/",
		title: "Example",
		tagName: "BUTTON",
		id: "cta",
		classes: ["btn"],
		selector: "#cta",
		html: "<button>Go</button>",
		styles: { display: "block" },
		rect: { x: 1, y: 2, width: 30, height: 20 },
	};

	it("injects the picker script when toggled on and the cancel script when toggled off", async () => {
		setupCaptureApi();
		const { result } = setup();
		const { guest, calls } = fakePickGuest(null);
		attachGuest(result.current, guest);
		act(() => result.current.onTogglePicker());
		await flushInjection();
		expect(result.current.pickerActive).toBe(true);
		expect(calls.some((code) => code.includes("__vettaPickerCleanup") && code.length > 500)).toBe(true);

		act(() => result.current.onTogglePicker());
		expect(result.current.pickerActive).toBe(false);
	});

	it("captures a picked element into the composer as image token plus text block", async () => {
		setupCaptureApi();
		vi.useFakeTimers();
		try {
			const { result } = setup();
			const { guest } = fakePickGuest(picked);
			attachGuest(result.current, guest);
			act(() => result.current.onTogglePicker());
			await act(async () => {
				await Promise.resolve();
			});
			await act(async () => {
				vi.advanceTimersByTime(400);
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(pickerMocks.composerImages).toEqual(["/tmp/element-30x20.png"]);
			expect(pickerMocks.composerText.join("\n")).toContain("Selector: #cta");
			expect(pickerMocks.focused).toBe(true);
			expect(result.current.pickerActive).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
