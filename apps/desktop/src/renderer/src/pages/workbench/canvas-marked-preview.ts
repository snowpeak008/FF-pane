/**
 * 把气泡和字画进一张预览 PNG，给改图的窗口看绘制落在哪里。
 * 不改原图。坐标与画板上的 SVG 一致，单位是原图像素。
 */

import type { CanvasAnnotation } from "@ff-pane/shared";
import { projectImageTag } from "../../../../shared/canvas-image-tag";
import { labelMetrics } from "./canvas-view";

const TEXT_FONT = '"Microsoft YaHei", "Segoe UI", sans-serif';

function drawOutlinedText(
  ctx: CanvasRenderingContext2D,
  text: string | undefined,
  x: number,
  y: number,
  color: string,
): void {
  if (text === undefined || text.trim() === "") {
    return;
  }
  ctx.font = `16px ${TEXT_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ffffff";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  item: CanvasAnnotation,
  number: number,
  radius: number,
  font: number,
): void {
  ctx.beginPath();
  ctx.arc(item.x, item.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = item.color;
  ctx.fill();
  ctx.lineWidth = Math.max(2, radius * 0.12);
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = `600 ${font}px ${TEXT_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(number), item.x, item.y);
  const text = item.text?.trim() ?? "";
  if (text === "") {
    return;
  }
  ctx.font = `${font}px ${TEXT_FONT}`;
  ctx.textAlign = "left";
  const pad = Math.round(font * 0.35);
  const width = ctx.measureText(text).width + pad * 2;
  const height = font + pad * 2;
  const left = item.x + radius + Math.round(font * 0.35);
  const top = item.y - height / 2;
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  fillRoundRect(ctx, left, top, width, height, Math.round(height / 2));
  ctx.fillStyle = item.color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, left + pad, item.y);
}

function drawMarks(
  ctx: CanvasRenderingContext2D,
  annotations: readonly CanvasAnnotation[],
  imageW: number,
  imageH: number,
): void {
  const { radius, font } = labelMetrics(imageW, imageH);
  const labels = annotations.filter((item) => item.kind === "label");
  for (const item of annotations) {
    if (item.kind === "rect") {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = Math.max(2, radius * 0.12);
      ctx.strokeRect(item.x, item.y, item.w, item.h);
      drawOutlinedText(ctx, item.text ?? item.label, item.x, item.y - font, item.color);
      continue;
    }
    if (item.kind === "text") {
      drawOutlinedText(ctx, item.text ?? item.label, item.x, item.y, item.color);
      continue;
    }
    const number = labels.findIndex((entry) => entry.id === item.id) + 1;
    drawLabel(ctx, item, number, radius, font);
  }
}

/** 返回不含 data: 前缀的 PNG base64。画不出来时返回 null。 */
export async function renderCanvasMarkedPng(
  src: string,
  annotations: readonly CanvasAnnotation[],
  imagePath: string,
): Promise<string | null> {
  if (annotations.length === 0 || src.trim() === "") {
    return null;
  }
  try {
    const image = new Image();
    image.src = src;
    await image.decode();
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      return null;
    }
    const tag = projectImageTag(imagePath);
    const strip = Math.max(36, Math.round(image.naturalWidth * 0.055));
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight + strip;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return null;
    }
    ctx.drawImage(image, 0, 0);
    drawMarks(ctx, annotations, image.naturalWidth, image.naturalHeight);
    const border = Math.max(4, Math.round(image.naturalWidth * 0.006));
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = border;
    ctx.strokeRect(
      border / 2,
      border / 2,
      image.naturalWidth - border,
      image.naturalHeight - border,
    );
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, image.naturalHeight, image.naturalWidth, strip);
    ctx.fillStyle = "#ffffff";
    ctx.font = `${Math.max(14, Math.round(strip * 0.38))}px ${TEXT_FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(tag.label, 12, image.naturalHeight + strip / 2);
    const url = canvas.toDataURL("image/png");
    const marker = "base64,";
    const index = url.indexOf(marker);
    if (index < 0) {
      return null;
    }
    return url.slice(index + marker.length);
  } catch {
    return null;
  }
}
