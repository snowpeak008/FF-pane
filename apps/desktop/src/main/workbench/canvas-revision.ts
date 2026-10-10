/**
 * 用户对不满意的生图打的修改要求。
 * 文字在 `.ffpane/canvas/revisions/<文件名>.revision.json`。
 * 绘制在同目录 `<文件名>.marked.png`。原图像素不改。
 */

import type { CanvasAnnotation } from "@ff-pane/shared";
import { isCanvasImageFileName } from "@ff-pane/shared";
import { projectImageTag } from "../../shared/canvas-image-tag";

export const CANVAS_REVISIONS_DIR = "revisions";
export const CANVAS_REVISION_VERSION = 1 as const;
export const CANVAS_REVISION_MAX_MARKS = 100;
export const CANVAS_REVISION_TEXT_MAX = 400;

export const CANVAS_REVISION_PURPOSE =
  "用户对这张图不满意，在画板上标了修改要求。marks 的 text 是文字要求；markedImage 是画在画面上的标记。按这两方面改 image 指向的原图。新图不要把气泡、数字和标注文字画进去。";

export interface CanvasRevisionMark {
  readonly number?: number;
  readonly kind: CanvasAnnotation["kind"];
  readonly color: string;
  readonly text?: string;
  readonly x: number;
  readonly y: number;
  readonly w?: number;
  readonly h?: number;
  readonly nx?: number;
  readonly ny?: number;
  readonly nw?: number;
  readonly nh?: number;
}

export interface CanvasRevisionFile {
  readonly v: typeof CANVAS_REVISION_VERSION;
  readonly image: string;
  readonly imageTag: string;
  readonly markedImage: string;
  readonly purpose: string;
  readonly imageWidth?: number;
  readonly imageHeight?: number;
  readonly marks: readonly CanvasRevisionMark[];
}

export interface CanvasRevisionForTool extends CanvasRevisionFile {
  readonly markedImageReady: boolean;
}

const MAX_RASTER_EDGE = 100_000;
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export function isCanvasDerivedFileName(name: string): boolean {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  return base.endsWith(".revision.json") || base.endsWith(".marked.png");
}

/** 只收 canvas 根目录里的原图。修订预览和子目录不进画板。 */
export function shouldIngestCanvasFileName(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, "/");
  if (normalized.includes("/") || isCanvasDerivedFileName(normalized)) {
    return false;
  }
  return isCanvasImageFileName(normalized);
}

export function canvasRevisionRelative(imageFileName: string): {
  readonly json: string;
  readonly marked: string;
} {
  const dir = `.ffpane/canvas/${CANVAS_REVISIONS_DIR}`;
  return {
    json: `${dir}/${imageFileName}.revision.json`,
    marked: `${dir}/${imageFileName}.marked.png`,
  };
}

export function sourceImageNameFromDerived(fileName: string): string | undefined {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? fileName;
  if (base.endsWith(".revision.json")) {
    const source = base.slice(0, -".revision.json".length);
    return source.length > 0 ? source : undefined;
  }
  if (base.endsWith(".marked.png")) {
    const source = base.slice(0, -".marked.png".length);
    return source.length > 0 ? source : undefined;
  }
  return undefined;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clipText(value: string): string {
  const chars = [...value];
  if (chars.length <= CANVAS_REVISION_TEXT_MAX) {
    return value;
  }
  return `${chars.slice(0, CANVAS_REVISION_TEXT_MAX).join("")}…`;
}

function ratio(value: number, total: number | undefined): number | undefined {
  if (total === undefined || !Number.isFinite(total) || total <= 0 || !Number.isFinite(value)) {
    return undefined;
  }
  return roundTo(value / total, 4);
}

function markText(item: CanvasAnnotation, number: number | undefined): string | undefined {
  if (typeof item.text === "string" && item.text.trim() !== "") {
    return clipText(item.text.trim());
  }
  if (typeof item.label === "string") {
    const trimmed = item.label.trim();
    if (trimmed !== "" && trimmed !== String(number ?? "")) {
      return clipText(trimmed);
    }
  }
  return undefined;
}

export function buildCanvasRevisionFile(
  imageRelative: string,
  imageFileName: string,
  items: readonly CanvasAnnotation[],
  size: { readonly width: number; readonly height: number } | undefined,
): CanvasRevisionFile | undefined {
  let labelNumber = 0;
  const marks: CanvasRevisionMark[] = [];
  for (const item of items) {
    if (marks.length >= CANVAS_REVISION_MAX_MARKS) {
      break;
    }
    if (![item.x, item.y, item.w, item.h].every((value) => Number.isFinite(value))) {
      continue;
    }
    const number = item.kind === "label" ? ++labelNumber : undefined;
    const text = markText(item, number);
    const nx = ratio(item.x, size?.width);
    const ny = ratio(item.y, size?.height);
    const nw = item.kind === "label" ? undefined : ratio(item.w, size?.width);
    const nh = item.kind === "label" ? undefined : ratio(item.h, size?.height);
    marks.push({
      ...(number !== undefined ? { number } : {}),
      kind: item.kind,
      color: item.color,
      ...(text !== undefined ? { text } : {}),
      x: roundTo(item.x, 1),
      y: roundTo(item.y, 1),
      ...(item.kind === "label" ? {} : { w: roundTo(item.w, 1), h: roundTo(item.h, 1) }),
      ...(nx !== undefined ? { nx } : {}),
      ...(ny !== undefined ? { ny } : {}),
      ...(nw !== undefined ? { nw } : {}),
      ...(nh !== undefined ? { nh } : {}),
    });
  }
  if (marks.length === 0) {
    return undefined;
  }
  return {
    v: CANVAS_REVISION_VERSION,
    image: imageRelative,
    imageTag: projectImageTag(imageRelative).label,
    markedImage: canvasRevisionRelative(imageFileName).marked,
    purpose: CANVAS_REVISION_PURPOSE,
    ...(size !== undefined ? { imageWidth: size.width, imageHeight: size.height } : {}),
    marks,
  };
}

function finiteEdge(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } | undefined {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_RASTER_EDGE ||
    height > MAX_RASTER_EDGE
  ) {
    return undefined;
  }
  return { width, height };
}

function jpegSize(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || marker === 0xff) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      return undefined;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) {
      return undefined;
    }
    if (JPEG_SOF.has(marker)) {
      return finiteEdge(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    offset += 2 + length;
  }
  return undefined;
}

/** 从文件头读宽高。认不出时不猜。 */
export function readRasterSize(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes.toString("ascii", 1, 4) === "PNG") {
    if (bytes.toString("ascii", 12, 16) !== "IHDR") {
      return undefined;
    }
    return finiteEdge(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 4) === "GIF8") {
    return finiteEdge(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  }
  if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    bytes.toString("ascii", 12, 16) === "VP8X"
  ) {
    return finiteEdge(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegSize(bytes);
  }
  return undefined;
}
