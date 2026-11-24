import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webContents } from "electron";

export interface ElementCaptureRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface ElementCaptureResult {
	readonly path: string;
	readonly width: number;
	readonly height: number;
}

const MAX_CAPTURE_EDGE = 4000;
const CAPTURE_DIR = join(tmpdir(), "vetta-element-captures");

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * 校验输入并截取 guest webview 中元素的可见区域，落盘为 PNG。
 *
 * 安全边界：只接受类型为 webview 的 guest webContents（本应用内嵌浏览器的
 * guest），拒绝本窗口或其他任意 webContents——否则等于把任意窗口内容的
 * 截图能力开放给渲染层。rect 必须是有限正数并封顶边长。
 */
export async function captureElementScreenshot(
	webContentsId: unknown,
	rectInput: unknown,
): Promise<ElementCaptureResult> {
	if (!isFiniteNumber(webContentsId) || webContentsId <= 0) {
		throw new Error("invalid webContentsId");
	}
	const rect = rectInput as ElementCaptureRect | null;
	if (
		!rect ||
		!isFiniteNumber(rect.x) ||
		!isFiniteNumber(rect.y) ||
		!isFiniteNumber(rect.width) ||
		!isFiniteNumber(rect.height) ||
		rect.width <= 0 ||
		rect.height <= 0 ||
		rect.width > MAX_CAPTURE_EDGE ||
		rect.height > MAX_CAPTURE_EDGE
	) {
		throw new Error("invalid capture rect");
	}
	const contents = webContents.fromId(webContentsId);
	if (!contents || contents.isDestroyed() || contents.getType() !== "webview") {
		throw new Error("capture target is not an embedded browser view");
	}
	// capturePage 的 rect 语义是页面视口坐标内的裁剪；元素可能部分在视口外，
	// 截断交给 Electron（越界区域自动裁掉），空结果视为失败。
	const image = await contents.capturePage({
		x: Math.max(0, Math.round(rect.x)),
		y: Math.max(0, Math.round(rect.y)),
		width: Math.round(rect.width),
		height: Math.round(rect.height),
	});
	if (image.isEmpty()) {
		throw new Error("element is outside the visible viewport");
	}
	await mkdir(CAPTURE_DIR, { recursive: true });
	const path = join(CAPTURE_DIR, `element-${Date.now()}.png`);
	await writeFile(path, image.toPNG());
	const size = image.getSize();
	return { path, width: size.width, height: size.height };
}
