/**
 * Claude Code 原生 stream-json 的基础件（W2.4）：注册键、协议常量、取值助手。
 *
 * 为什么全是"软取值"而不是 zod/接口断言：docs/adapters/claude-code.md §9.3 坑 4
 * 把版本漂移列为常态——未知 `system` subtype、`tool_use_result` 对象/字符串双形态、
 * 非 JSON 行、截断流都是实测形态。故本适配器一律"能取到就用，取不到就缺席"，
 * 任何一处字段缺失都不得让整条流失败（那会丢掉后面全部证据）。
 */

import type { RuntimeId } from "@ff-pane/shared";
import { isJsonObject } from "../events/index.js";

/** 本适配器的注册键（KNOWN_RUNTIMES 之一）。 */
export const CLAUDE_CODE_RUNTIME: RuntimeId = "claude-code";

/** 界面显示名。 */
export const CLAUDE_CODE_DISPLAY_NAME = "Claude Code";

/**
 * `system/init` 的 capabilities 中声明 interrupt 控制协议的标志
 * （docs/adapters/claude-code.md §2.1 / §5 实测：本机 2.1.220 会报出它）。
 * 取消路径以它为开关：声明了才走优雅 interrupt，否则直接树杀——
 * 这是隐藏协议漂移的第一道防线。
 */
export const CLAUDE_INTERRUPT_RECEIPT_CAPABILITY = "interrupt_receipt_v1";

/** 文件类工具：其 tool_result 映射为 file_change。 */
export const CLAUDE_FILE_TOOLS: readonly string[] = [
  "Write",
  "Edit",
  "NotebookEdit",
  // MultiEdit 在 2.1.220 的 init.tools 里已不出现，保留以兼容旧版本 CLI。
  "MultiEdit",
];

/** 命令类工具：其 tool_result 映射为 command。 */
export const CLAUDE_COMMAND_TOOLS: readonly string[] = ["Bash"];

/** 只读类工具：权限请求映射为 read_path。 */
export const CLAUDE_READ_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];

/** 网络类工具：权限请求映射为 network。 */
export const CLAUDE_NETWORK_TOOLS: readonly string[] = ["WebFetch", "WebSearch"];

/** 字符串取值；非字符串（含缺席）返回 undefined。 */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 非空字符串取值：空串按缺席处理（Bash 的空 stderr 不该占一个字段）。 */
export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 有限数值取值；NaN / Infinity / 非数值返回 undefined。 */
export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** JSON 对象取值（排除 null 与数组）。 */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}

/** 数组取值。 */
export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

/** 对象数组取值：非对象元素直接滤掉（脏元素不该带崩整个数组）。 */
export function asObjectArray(value: unknown): readonly Record<string, unknown>[] {
  return (asArray(value) ?? []).filter(isJsonObject);
}
