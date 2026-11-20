// @vitest-environment jsdom

import { TabBar } from "@shared/components/ui/tab-bar";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const motionSpanProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("motion/react", async () => {
	const { createElement } = await import("react");
	return {
		motion: {
			// 透传为原生 span：保留 data-active-tab-indicator 等属性断言所需的 DOM，
			// 记录原始 props 供断言 layoutId/transition，再丢弃 motion 专有 props 渲染。
			span: (props: Record<string, unknown>) => {
				motionSpanProps.push(props);
				const { layoutId: _layoutId, transition: _transition, ...rest } = props;
				return createElement("span", rest);
			},
		},
	};
});

class ResizeObserverStub {
	disconnect(): void {}
	observe(): void {}
}

const capturedPointers = new WeakMap<Element, Set<number>>();

function pointerEvent(type: string, x: number, y: number, pointerId = 1): MouseEvent {
	const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
	Object.defineProperty(event, "pointerId", { value: pointerId });
	return event;
}

function fileDragEvent(type: string): Event {
	const event = new Event(type, { bubbles: true });
	Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"] } });
	return event;
}

function bounds(left: number, top: number, width: number, height: number): DOMRect {
	return {
		bottom: top + height,
		height,
		left,
		right: left + width,
		top,
		width,
		x: left,
		y: top,
		toJSON: () => ({}),
	};
}

function setTabBounds(container: HTMLElement): void {
	const row = container.querySelector<HTMLElement>("[data-tabkey]")?.parentElement;
	if (!row) throw new Error("tab row not found");
	row.getBoundingClientRect = () => bounds(0, 0, 300, 30);
	for (const [index, tab] of Array.from(row.children).entries()) {
		(tab as HTMLElement).getBoundingClientRect = () => bounds(index * 100, 0, 100, 30);
	}
}

describe("TabBar pointer drag", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		Object.defineProperties(HTMLElement.prototype, {
			setPointerCapture: {
				configurable: true,
				value(pointerId: number): void {
					const pointers = capturedPointers.get(this) ?? new Set<number>();
					pointers.add(pointerId);
					capturedPointers.set(this, pointers);
				},
			},
			hasPointerCapture: {
				configurable: true,
				value(pointerId: number): boolean {
					return capturedPointers.get(this)?.has(pointerId) ?? false;
				},
			},
			releasePointerCapture: {
				configurable: true,
				value(pointerId: number): void {
					capturedPointers.get(this)?.delete(pointerId);
				},
			},
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		document.querySelector<HTMLElement>("[data-tab-drag-overlay]")?.remove();
	});

	it("uses a static active indicator while layout animation is suppressed", () => {
		motionSpanProps.length = 0;
		act(() => {
			root.render(
				createElement(TabBar, {
					items: [{ key: "a", label: "A" }],
					value: "a",
					onChange: vi.fn(),
					suppressLayoutAnimation: true,
				}),
			);
		});
		// 指示器节点始终渲染；抑制动画时不再携带 layoutId，且过渡时长归零。
		expect(container.querySelector("[data-active-tab-indicator]")).not.toBeNull();
		const suppressed = motionSpanProps.at(-1);
		expect(suppressed?.layoutId).toBeUndefined();
		expect(suppressed?.transition).toEqual({ duration: 0 });

		motionSpanProps.length = 0;
		act(() => {
			root.render(
				createElement(TabBar, {
					items: [{ key: "a", label: "A" }],
					value: "a",
					onChange: vi.fn(),
					suppressLayoutAnimation: false,
				}),
			);
		});
		const animated = motionSpanProps.at(-1);
		expect(typeof animated?.layoutId).toBe("string");
	});

	it("measures the active indicator before paint so the tab outline can draw", () => {
		// 上游为修复拖动面板宽度后轮廓丢失，把宽度测量改回绘制前同步读取；
		// 宽度大于 0 时才会画出三边连接轮廓，这里用 offsetWidth 桩验证整条链路。
		const offsetWidth = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(80);

		try {
			act(() => {
				root.render(
					createElement(TabBar, {
						items: [{ key: "a", label: "A" }],
						value: "a",
						onChange: vi.fn(),
						suppressLayoutAnimation: true,
					}),
				);
			});
			expect(container.querySelector("[data-connected-tab-outline]")).not.toBeNull();
		} finally {
			offsetWidth.mockRestore();
		}
	});

	it("keeps a click below the drag threshold", () => {
		const onChange = vi.fn();
		const onDragStart = vi.fn();
		act(() => {
			root.render(
				createElement(TabBar, {
					items: [{ key: "a", label: "A" }],
					value: "a",
					onChange,
					onReorder: vi.fn(),
					onTabDragStart: onDragStart,
				}),
			);
		});
		setTabBounds(container);
		const tab = container.querySelector<HTMLElement>('[data-tabkey="a"]');
		const button = tab?.querySelector("button");
		if (!tab || !button) throw new Error("tab not found");
		act(() => {
			tab.dispatchEvent(pointerEvent("pointerdown", 10, 10));
			expect(capturedPointers.get(tab)?.size ?? 0).toBe(0);
			tab.dispatchEvent(pointerEvent("pointermove", 12, 11));
			tab.dispatchEvent(pointerEvent("pointerup", 12, 11));
			button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onChange).toHaveBeenCalledOnce();
		expect(onDragStart).not.toHaveBeenCalled();
		expect(document.querySelector("[data-tab-drag-overlay]")).toBeNull();
	});

	it("activates a tab after a file drag hovers over it", () => {
		vi.useFakeTimers();
		const onChange = vi.fn();
		act(() => {
			root.render(
				createElement(TabBar, {
					items: [
						{ key: "a", label: "A" },
						{ key: "b", label: "B" },
					],
					value: "a",
					onChange,
					activateOnFileDragHover: true,
				}),
			);
		});
		const tab = container.querySelector<HTMLElement>('[data-tabkey="b"]');
		if (!tab) throw new Error("tab not found");

		act(() => tab.dispatchEvent(fileDragEvent("dragenter")));
		expect(tab.hasAttribute("data-file-drag-hover")).toBe(true);
		expect(onChange).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(300));
		expect(onChange).toHaveBeenCalledWith("b");
	});

	it("keeps the close action inside the active tab", () => {
		const onChange = vi.fn();
		const onRemove = vi.fn();
		act(() => {
			root.render(
				createElement(TabBar, {
					items: [
						{ key: "a", label: "A" },
						{ key: "b", label: "B", removable: true },
					],
					value: "b",
					onChange,
					onRemove,
					removeLabel: "Hide tab",
				}),
			);
		});
		const close = container.querySelector<HTMLButtonElement>('button[aria-label="Hide tab: B"]');
		if (!close) throw new Error("close button not found");

		act(() => close.click());
		expect(onRemove).toHaveBeenCalledWith("b");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("continues dragging after the source tab is removed", () => {
		const onDragEnd = vi.fn();
		function Harness(): ReturnType<typeof createElement> {
			const [items, setItems] = useState([
				{ key: "a", label: "A" },
				{ key: "b", label: "B" },
			]);
			return createElement(TabBar, {
				items,
				value: items[0]?.key ?? "b",
				onChange: vi.fn(),
				onReorder: vi.fn(),
				onTabDragMove: (event) => {
					if (event.point.y > 60) setItems((current) => current.filter((item) => item.key !== event.key));
				},
				onTabDragEnd: onDragEnd,
			});
		}
		act(() => root.render(createElement(Harness)));
		setTabBounds(container);
		const tab = container.querySelector<HTMLElement>('[data-tabkey="a"]');
		if (!tab) throw new Error("tab not found");
		act(() => {
			tab.dispatchEvent(pointerEvent("pointerdown", 10, 10));
			tab.dispatchEvent(pointerEvent("pointermove", 20, 10));
		});
		const overlay = document.querySelector<HTMLElement>("[data-tab-drag-overlay]");
		if (!overlay) throw new Error("drag overlay not found");
		act(() => overlay.dispatchEvent(pointerEvent("pointermove", 120, 100)));
		expect(container.querySelector('[data-tabkey="a"]')).toBeNull();
		act(() => overlay.dispatchEvent(pointerEvent("pointerup", 120, 100)));
		expect(onDragEnd).toHaveBeenCalledWith(
			expect.objectContaining({ cancelled: false, key: "a", point: { x: 120, y: 100 } }),
		);
		expect(document.querySelector("[data-tab-drag-overlay]")).toBeNull();
	});

	it("cancels reordered state on Escape", () => {
		const onReorder = vi.fn();
		const onDragEnd = vi.fn();
		act(() => {
			root.render(
				createElement(TabBar, {
					items: [
						{ key: "a", label: "A" },
						{ key: "b", label: "B" },
					],
					value: "a",
					onChange: vi.fn(),
					onReorder,
					onTabDragEnd: onDragEnd,
				}),
			);
		});
		setTabBounds(container);
		const tab = container.querySelector<HTMLElement>('[data-tabkey="a"]');
		if (!tab) throw new Error("tab not found");
		act(() => {
			tab.dispatchEvent(pointerEvent("pointerdown", 10, 10));
			tab.dispatchEvent(pointerEvent("pointermove", 20, 10));
		});
		const overlay = document.querySelector<HTMLElement>("[data-tab-drag-overlay]");
		if (!overlay) throw new Error("drag overlay not found");
		act(() => {
			overlay.dispatchEvent(pointerEvent("pointermove", 250, 10));
			document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
		});
		expect(onReorder).not.toHaveBeenCalled();
		expect(onDragEnd).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true, key: "a" }));
		expect(document.querySelector("[data-tab-drag-overlay]")).toBeNull();
	});

	it("lets the host take over a detached drag without committing tab order", () => {
		const onReorder = vi.fn();
		act(() => {
			root.render(
				createElement(TabBar, {
					items: [
						{ key: "a", label: "A" },
						{ key: "b", label: "B" },
					],
					value: "a",
					onChange: vi.fn(),
					onReorder,
					onTabDragEnd: () => false,
				}),
			);
		});
		setTabBounds(container);
		const tab = container.querySelector<HTMLElement>('[data-tabkey="a"]');
		if (!tab) throw new Error("tab not found");
		act(() => {
			tab.dispatchEvent(pointerEvent("pointerdown", 10, 10));
			tab.dispatchEvent(pointerEvent("pointermove", 20, 10));
		});
		const overlay = document.querySelector<HTMLElement>("[data-tab-drag-overlay]");
		if (!overlay) throw new Error("drag overlay not found");
		act(() => {
			overlay.dispatchEvent(pointerEvent("pointermove", 250, 10));
			overlay.dispatchEvent(pointerEvent("pointerup", 250, 10));
		});
		expect(onReorder).not.toHaveBeenCalled();
	});
});
