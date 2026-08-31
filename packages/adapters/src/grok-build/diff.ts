/**
 * Grok 的文件变更载荷 → unified diff 文本（T7.3）。
 *
 * grok 是四家（现五家）里唯一把变更正文直接放进事件流的：
 * `tool_call_update.content[]` 里 `type: "diff"` 的条目带 `path` + `oldText` + `newText`
 * 全文，完成态还额外带 `_meta.details[]`（逐处编辑的新旧串 + 行号 + 上下文）。
 * 因此这一家不需要 codex 那套 git 快照自补。
 *
 * 但 FileChangeEvent.diff 的约定是 **unified diff 文本**（消费方是渲染层的 DiffView 与
 * Run 的 changes.diff），所以要在这里把 grok 的结构渲染成文本。两条路径：
 *
 * 1. **有 `_meta.details` 时按 details 渲染**——每处编辑一个 hunk，只输出真正变动的行
 *    加上下文。这是首选：一个 500 行文件改一行，全文替换式的 diff 会产出 1000 行
 *    「全删全增」，那不是变更证据，是噪声。
 * 2. **没有 details 时退回新旧全文对比**——按整段替换渲染成一个 hunk。行级 LCS
 *    在这里刻意不做：本模块的职责是如实转录 grok 已经算好的编辑，而不是自己
 *    重新推断「哪几行变了」，那属于另一种事实（推断结果与 CLI 实际所做未必一致）。
 *
 * 纯函数、零 I/O，可直接用 fixture 回放。
 */

import { isJsonObject } from "../events/index.js";

/** 一处编辑（grok `_meta.details[]` 的条目）。字段名沿用原生。 */
interface GrokEditDetail {
  readonly oldString: string;
  readonly newString: string;
  readonly oldLine: number;
  readonly newLine: number;
  readonly contextBefore: string;
  readonly contextAfter: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 把一段文本切成行。空串 → 零行（而非一行空串）：文件创建时 oldText 是空串，
 * 若算作一行，diff 里会凭空多出一条「删除空行」。
 */
function toLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  // 末尾换行不产生一行空行（与 git 的 unified diff 一致）。
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function parseDetails(meta: unknown): readonly GrokEditDetail[] {
  if (!isJsonObject(meta)) {
    return [];
  }
  const details = meta["details"];
  if (!Array.isArray(details)) {
    return [];
  }
  const parsed: GrokEditDetail[] = [];
  for (const entry of details) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const oldString = asString(entry["old_string"]);
    const newString = asString(entry["new_string"]);
    if (oldString === undefined && newString === undefined) {
      continue;
    }
    parsed.push({
      oldString: oldString ?? "",
      newString: newString ?? "",
      oldLine: asNumber(entry["old_line"]) ?? 1,
      newLine: asNumber(entry["new_line"]) ?? 1,
      contextBefore: asString(entry["context_before"]) ?? "",
      contextAfter: asString(entry["context_after"]) ?? "",
    });
  }
  return parsed;
}

/** 一个 hunk 的行集合渲染。 */
function renderHunk(detail: GrokEditDetail): string[] {
  const before = toLines(detail.contextBefore);
  const after = toLines(detail.contextAfter);
  const removed = toLines(detail.oldString);
  const added = toLines(detail.newString);
  const oldCount = before.length + removed.length + after.length;
  const newCount = before.length + added.length + after.length;
  // 起始行号回退到上下文之前（grok 给的 old_line/new_line 指向变动处本身）。
  const oldStart = Math.max(1, detail.oldLine - before.length);
  const newStart = Math.max(1, detail.newLine - before.length);
  return [
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...before.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...after.map((line) => ` ${line}`),
  ];
}

/** 整段替换的兜底 hunk（无 details 时）。 */
function renderWholeFile(oldText: string, newText: string): string[] {
  const removed = toLines(oldText);
  const added = toLines(newText);
  return [
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
}

/** renderGrokDiff 的输入（已从原生 content[] 条目里取出）。 */
export interface GrokDiffInput {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  /** 原生 `_meta` 对象（含 details[]）；缺席时走整段替换兜底。 */
  readonly meta?: unknown;
}

/**
 * 渲染 unified diff 文本。新旧全文完全相同且无 details 时返回 undefined
 * ——「没有变化」不该产出一个空 diff 字段（events/types.ts 的字段缺席语义）。
 */
export function renderGrokDiff(input: GrokDiffInput): string | undefined {
  const details = parseDetails(input.meta);
  const body =
    details.length > 0
      ? details.flatMap((detail) => renderHunk(detail))
      : input.oldText === input.newText
        ? []
        : renderWholeFile(input.oldText, input.newText);
  if (body.length === 0) {
    return undefined;
  }
  return [`--- a/${input.path}`, `+++ b/${input.path}`, ...body].join("\n");
}

/** 从 grok `content[]` 里挑出 diff 条目并渲染；无 diff 条目时返回 undefined。 */
export function renderGrokDiffFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const rendered: string[] = [];
  for (const entry of content) {
    if (!isJsonObject(entry) || entry["type"] !== "diff") {
      continue;
    }
    const path = asString(entry["path"]);
    if (path === undefined) {
      continue;
    }
    const diff = renderGrokDiff({
      path,
      oldText: asString(entry["oldText"]) ?? "",
      newText: asString(entry["newText"]) ?? "",
      meta: entry["_meta"],
    });
    if (diff !== undefined) {
      rendered.push(diff);
    }
  }
  return rendered.length === 0 ? undefined : rendered.join("\n");
}

/** 从 grok `content[]` 里取第一个 diff 条目的路径（file_change 的 path 来源之一）。 */
export function firstDiffPath(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const entry of content) {
    if (isJsonObject(entry) && entry["type"] === "diff") {
      const path = asString(entry["path"]);
      if (path !== undefined) {
        return path;
      }
    }
  }
  return undefined;
}
