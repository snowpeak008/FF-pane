/**
 * 工作台记忆工具的裁决与限额（T10.10）。
 * 纯函数加每窗口写入间隔。文件读写仍走现有记忆存储，不在这里发生。
 */

import { Buffer } from "node:buffer";
import type { MemoryEntry, WorkbenchOpenedBy } from "@ff-pane/shared";
import { sanitizeThreadBody, stripControls } from "./remind";

/** 一次检索最多带回的条数（与注入上限同一量级，避免把整库灌进上下文）。 */
export const MEMORY_SEARCH_MAX_HITS = 20;
/** 一次检索返回的标题加正文，UTF-8 合计不超过这个字节数。 */
export const MEMORY_SEARCH_MAX_BYTES = 16 * 1024;
/** 查询原文的码点上限。更长的句子请改短后再查。 */
export const MEMORY_SEARCH_QUERY_MAX_CHARS = 200;
/** 新增标题的码点上限。 */
export const MEMORY_ADD_TITLE_MAX_CHARS = 120;
/** 新增正文的码点上限。 */
export const MEMORY_ADD_BODY_MAX_CHARS = 2000;
/** 同一窗口两次成功写入的最小间隔。 */
export const MEMORY_ADD_MIN_INTERVAL_MS = 10_000;
/** 记到条目上的窗口标题码点上限。 */
export const MEMORY_SOURCE_TITLE_MAX_CHARS = 80;

const lastMemoryAddAt = new Map<string, number>();

export function canAddProjectMemory(input: {
  readonly managerGranted: boolean;
  readonly openedBy: WorkbenchOpenedBy;
  readonly sanitizeLocked: boolean;
}): boolean {
  if (input.sanitizeLocked) {
    return false;
  }
  return input.managerGranted || input.openedBy === "user";
}

export function codePointLength(text: string): number {
  return [...text].length;
}

/** 标题不保留换行。控制字符全部去掉。 */
export function sanitizeMemoryTitle(text: string): string {
  return stripControls(text).replaceAll("\n", "").trim();
}

/** 正文保留换行，去掉其它 C0 与 DEL，并把 \\r\\n 收成 \\n。 */
export function sanitizeMemoryBody(text: string): string {
  return sanitizeThreadBody(text).trim();
}

export function sanitizeSourceWindowTitle(title: string): string {
  const clean = sanitizeMemoryTitle(title);
  const sliced = [...clean].slice(0, MEMORY_SOURCE_TITLE_MAX_CHARS).join("");
  return sliced.length > 0 ? sliced : "窗口";
}

export function memoryAddTooSoon(windowId: string, now: number): boolean {
  const previous = lastMemoryAddAt.get(windowId);
  return previous !== undefined && now - previous < MEMORY_ADD_MIN_INTERVAL_MS;
}

export function noteMemoryAdd(windowId: string, now: number): void {
  lastMemoryAddAt.set(windowId, now);
}

/**
 * 检查通过后立刻占住间隔，再去写文件。
 * 同一窗口两笔同时进来时，后一笔会看到这个时间。写失败也占着，避免并发都成功。
 */
export function reserveMemoryAdd(windowId: string, now: number): boolean {
  if (memoryAddTooSoon(windowId, now)) {
    return false;
  }
  noteMemoryAdd(windowId, now);
  return true;
}

export function resetMemoryAddSlots(): void {
  lastMemoryAddAt.clear();
}

export interface PackedMemoryHit {
  readonly id: string;
  readonly category: MemoryEntry["category"];
  readonly status: MemoryEntry["status"];
  readonly title: string;
  readonly body: string;
  readonly source: MemoryEntry["source"];
  readonly updatedAt: number;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || utf8Length(text) <= maxBytes) {
    return maxBytes <= 0 ? "" : text;
  }
  let out = "";
  for (const char of text) {
    const next = out + char;
    if (utf8Length(next) > maxBytes) {
      break;
    }
    out = next;
  }
  return out;
}

/**
 * 按条数和总字节装箱。装不下的正文截断后停止，避免半条之后再塞下一条。
 */
export function packMemorySearchHits(
  entries: readonly MemoryEntry[],
  maxHits: number,
  maxBytes: number,
): { readonly hits: readonly PackedMemoryHit[]; readonly truncated: boolean } {
  const hits: PackedMemoryHit[] = [];
  let used = 0;
  let truncated = false;
  const slice = entries.slice(0, Math.max(0, maxHits));
  if (entries.length > slice.length) {
    truncated = true;
  }
  for (const entry of slice) {
    const titleBytes = utf8Length(entry.title);
    const room = maxBytes - used - titleBytes;
    if (room < 0) {
      truncated = true;
      break;
    }
    const body = truncateUtf8(entry.body, room);
    if (body !== entry.body) {
      truncated = true;
    }
    hits.push({
      id: entry.id,
      category: entry.category,
      status: entry.status,
      title: entry.title,
      body,
      source: entry.source,
      updatedAt: entry.updatedAt,
    });
    used += titleBytes + utf8Length(body);
    if (body !== entry.body) {
      break;
    }
  }
  return { hits, truncated };
}
