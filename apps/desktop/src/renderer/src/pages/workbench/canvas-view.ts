/**
 * 画板视口：把原图缩进画面、滚轮对着光标缩放、气泡按屏幕像素点选。
 * 标注坐标仍是原图像素。
 */

export interface ViewTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export const MIN_VIEW_SCALE = 0.02;
export const MAX_VIEW_SCALE = 12;
export const BUBBLE_HIT_PX = 18;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return 1;
  }
  return Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, scale));
}

/** 大图缩进容器并留白，小图保持原大居中。容器还没布局好时不猜。 */
export function fitImageView(
  containerW: number,
  containerH: number,
  imageW: number,
  imageH: number,
  padding = 32,
): ViewTransform | undefined {
  if (containerW < 8 || containerH < 8 || imageW <= 0 || imageH <= 0) {
    return undefined;
  }
  const availW = Math.max(1, containerW - padding * 2);
  const availH = Math.max(1, containerH - padding * 2);
  const scale = clampScale(Math.min(1, availW / imageW, availH / imageH));
  return {
    scale,
    x: (containerW - imageW * scale) / 2,
    y: (containerH - imageH * scale) / 2,
  };
}

/** 缩放后，光标底下的那个图像素仍留在光标下。 */
export function zoomAtPoint(
  view: ViewTransform,
  cursorX: number,
  cursorY: number,
  nextScale: number,
): ViewTransform {
  const scale = clampScale(nextScale);
  const imageX = (cursorX - view.x) / view.scale;
  const imageY = (cursorY - view.y) / view.scale;
  return {
    scale,
    x: cursorX - imageX * scale,
    y: cursorY - imageY * scale,
  };
}

export function imagePointFromScreen(
  view: ViewTransform,
  cursorX: number,
  cursorY: number,
): { readonly x: number; readonly y: number } {
  return {
    x: (cursorX - view.x) / view.scale,
    y: (cursorY - view.y) / view.scale,
  };
}

export function screenPointFromImage(
  view: ViewTransform,
  imageX: number,
  imageY: number,
): { readonly x: number; readonly y: number } {
  return {
    x: view.x + imageX * view.scale,
    y: view.y + imageY * view.scale,
  };
}

export function isInsideImage(x: number, y: number, imageW: number, imageH: number): boolean {
  return x >= 0 && y >= 0 && x <= imageW && y <= imageH;
}

export function clampImagePoint(
  x: number,
  y: number,
  imageW: number,
  imageH: number,
): { readonly x: number; readonly y: number } {
  const maxX = imageW > 0 ? imageW : 0;
  const maxY = imageH > 0 ? imageH : 0;
  return {
    x: Math.min(maxX, Math.max(0, x)),
    y: Math.min(maxY, Math.max(0, y)),
  };
}

export function draggedImagePoint(
  originX: number,
  originY: number,
  startClientX: number,
  startClientY: number,
  clientX: number,
  clientY: number,
  scale: number,
  imageW: number,
  imageH: number,
): { readonly x: number; readonly y: number } {
  const safeScale = scale === 0 ? 1 : scale;
  return clampImagePoint(
    originX + (clientX - startClientX) / safeScale,
    originY + (clientY - startClientY) / safeScale,
    imageW,
    imageH,
  );
}

/** 滚轮一格大约一成，触控板的小位移不会一下子跳很远。 */
export function wheelScaleFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return 1;
  }
  const raw = Math.exp(-deltaY * 0.0015);
  return Math.min(1.25, Math.max(0.8, raw));
}

export function hitLabelId(
  items: readonly {
    readonly id: string;
    readonly kind: string;
    readonly x: number;
    readonly y: number;
    readonly text?: string;
  }[],
  view: ViewTransform,
  cursorX: number,
  cursorY: number,
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || item.kind !== "label") {
      continue;
    }
    const screen = screenPointFromImage(view, item.x, item.y);
    const dx = screen.x - cursorX;
    const dy = screen.y - cursorY;
    const onBubble = dx * dx + dy * dy <= BUBBLE_HIT_PX * BUBBLE_HIT_PX;
    const hasText = (item.text ?? "").trim() !== "";
    const onText =
      hasText &&
      cursorX >= screen.x + 8 &&
      cursorX <= screen.x + 200 &&
      cursorY >= screen.y - 16 &&
      cursorY <= screen.y + 16;
    if (onBubble || onText) {
      return item.id;
    }
  }
  return undefined;
}

/** 写进预览图时，气泡按画面短边放大，避免大图上只剩一个点。 */
export function labelMetrics(
  imageW: number,
  imageH: number,
): { readonly radius: number; readonly font: number } {
  const shortSide = Math.min(imageW, imageH);
  const radius = Math.round(Math.min(64, Math.max(18, shortSide * 0.035)));
  return { radius, font: Math.max(14, Math.round(radius * 0.9)) };
}
