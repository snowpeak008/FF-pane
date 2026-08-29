/**
 * `tool_use_result.structuredPatch` → unified diff 文本（W2.4）。
 *
 * Claude 是四家里唯一直接给出结构化 diff hunk 的 Runtime
 * （docs/adapters/claude-code.md §2.3，fixture 02 的 Edit 结果），本模块把它还原
 * 成 FileChangeEvent.diff 约定的 unified diff 文本。
 *
 * 三条实测约束：
 * 1. **Write 新建文件时 structuredPatch 是空数组**（fixture 01），此时不造假
 *    空 diff，返回 undefined 让 diff 字段缺席（events/types.ts 的缺席语义）；
 * 2. hunk 的 `lines` 已含 `-` / `+` / ` ` 前缀与 `\ No newline at end of file`
 *    标记，原样透传，不做二次加工；
 * 3. 文件头用 CLI 给的原始路径（Windows 绝对路径），路径归一化归权限层 W2.7。
 */

import { asArray, asNumber, asString } from "./native.js";

function formatHunkHeader(hunk: Record<string, unknown>): string {
  const oldStart = asNumber(hunk["oldStart"]) ?? 0;
  const oldLines = asNumber(hunk["oldLines"]) ?? 0;
  const newStart = asNumber(hunk["newStart"]) ?? 0;
  const newLines = asNumber(hunk["newLines"]) ?? 0;
  return `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`;
}

/**
 * 把 structuredPatch 渲染为 unified diff 文本。
 * patch 缺席、不是数组、为空数组或无一条合法 hunk 时返回 undefined。
 */
export function formatStructuredPatch(path: string, patch: unknown): string | undefined {
  const hunks = asArray(patch);
  if (hunks === undefined || hunks.length === 0) {
    return undefined;
  }
  const body: string[] = [];
  for (const hunk of hunks) {
    if (typeof hunk !== "object" || hunk === null || Array.isArray(hunk)) {
      continue;
    }
    const record = hunk as Record<string, unknown>;
    const lines = asArray(record["lines"]);
    if (lines === undefined) {
      continue;
    }
    body.push(formatHunkHeader(record));
    for (const line of lines) {
      const text = asString(line);
      if (text !== undefined) {
        body.push(text);
      }
    }
  }
  if (body.length === 0) {
    return undefined;
  }
  return `${[`--- ${path}`, `+++ ${path}`, ...body].join("\n")}\n`;
}
