/**
 * Qwen Code `-o stream-json` 原生信封的读取与收窄（T8.6a）。
 *
 * 权威依据：docs/adapters/qwen-code.md §3.2 的信封表 + 本机 0.23.0 真机录制
 * （fixtures/qwen-code/real-stream-json-*.jsonl）+ 安装包源码
 * （chunks/chunk-UAKRDON5.js 的 StreamJsonOutputAdapter 发射代码）。
 *
 * Qwen Code 是 Gemini CLI 的 fork，但 headless 输出协议已重写为 Claude Code
 * 风格信封（system/assistant/user/stream_event/result，内容在 message.content
 * 块数组里）——与 gemini 的六类扁平事件不同款（调研 §0 对照表）。
 *
 * 本模块只做"原生 JSON → 收窄后的原生形状"，不涉及统一事件语义（那是 mapper.ts）：
 * 字段一律按"可缺席"处理，形状不认识就返回 undefined，由映射器转 raw 事件上交。
 */

import type { RuntimeId } from "@ff-pane/shared";
import { createLiteralGuard } from "@ff-pane/shared";

/** 本适配器的 Runtime 注册键（adapter.ts KNOWN_RUNTIMES 之一）。 */
export const QWEN_CODE_RUNTIME: RuntimeId = "qwen-code";

/** 界面显示名。 */
export const QWEN_CODE_DISPLAY_NAME = "Qwen Code";

/** stream-json 信封的顶层判别值（调研 §3.2）。 */
export const QWEN_STREAM_ROW_TYPES = [
  "system",
  "stream_event",
  "assistant",
  "user",
  "result",
] as const;

/** 信封类型。 */
export type QwenStreamRowType = (typeof QWEN_STREAM_ROW_TYPES)[number];

/** QwenStreamRowType 运行时守卫。 */
export const isQwenStreamRowType = createLiteralGuard(QWEN_STREAM_ROW_TYPES);

/**
 * 文件编辑类工具名（参数键 file_path / notebook_path，gemini 血缘的工具语义层）。
 * write_file 另有 content；edit 另有 old_string/new_string。
 */
export const QWEN_EDIT_TOOL_NAMES = ["write_file", "edit", "notebook_edit"] as const;

/** 命令执行工具名（参数键 command / description / dir_path）。 */
export const QWEN_SHELL_TOOL_NAME = "run_shell_command";

/**
 * "权限被拒"的 tool_result 文本判据（0.23.0 源码字面量，chunk-4F7GQGXB.js）：
 * - `Qwen Code requires permission to use "X", but that permission was declined.`
 *   （可带 ` Matching deny rule: "Y".` 或 `(non-interactive mode cannot prompt
 *   for confirmation)` 后缀）；
 * - `"X" is not listed in the active core tools allowlist…`。
 * 注意整轮成败**不靠**这段文本——result.permission_denials 是结构化判据（调研 §3.4）；
 * 文本仅用于把单个动作改判 denied。
 */
export const QWEN_DENIAL_MESSAGE_PATTERNS: readonly RegExp[] = [
  /requires permission to use .+ but that permission was declined/i,
  /is not listed in the active core tools allowlist/i,
];

/**
 * API 错误升格文本的标记（0.23.0 源码字面量，chunk-4F7GQGXB.js）。
 * qwen 把 API 错误写成 assistant 文本 `[API Error: 401 …]` 后照常
 * result(success)/退出 0（调研 §8 坑 1，真机 fixture real-stream-json-api-error），
 * 命中即整轮改判 failed。措辞漂移的症状是漏判为 completed，fixture 钉住该字面量。
 */
export const QWEN_API_ERROR_MARKER = "[API Error:";

/** tool_result 文本是否命中"被拒"判据。 */
export function isQwenDenialText(text: string): boolean {
  return QWEN_DENIAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));
}

/** 是否为文件编辑类工具。 */
export function isQwenEditTool(toolName: string): boolean {
  const editTools: readonly string[] = QWEN_EDIT_TOOL_NAMES;
  return editTools.includes(toolName);
}

function readString(source: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(source: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readObject(
  source: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> | undefined {
  const value = source[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readArray(
  source: Readonly<Record<string, unknown>>,
  key: string,
): readonly unknown[] | undefined {
  const value = source[key];
  return Array.isArray(value) ? value : undefined;
}

function optional<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined,
): Record<TKey, TValue> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<TKey, TValue>);
}

/** system(subtype=init)：首行，携带会话 ID 与启动参数回显。 */
export interface QwenInitRow {
  readonly row: "init";
  readonly sessionId?: string;
  /** 启动参数回显（`-m` 的值原样），非实际解析的模型——不填 SessionStartEvent.model。 */
  readonly model?: string;
  readonly permissionMode?: string;
  readonly version?: string;
}

/** stream_event：过程事件（goal_state / message_start / content_block_* / message_stop）。 */
export interface QwenStreamEventRow {
  readonly row: "stream_event";
  readonly eventType?: string;
  readonly event: Readonly<Record<string, unknown>>;
}

/** assistant/user 行 message.content[] 的收窄块。 */
export type QwenContentBlock =
  | { readonly block: "text"; readonly text: string }
  | { readonly block: "thinking"; readonly text: string }
  | {
      readonly block: "tool_use";
      readonly id?: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly block: "tool_result";
      readonly toolUseId?: string;
      readonly isError: boolean;
      readonly content?: string;
    }
  | { readonly block: "unknown"; readonly native: unknown };

/** assistant：一条模型消息（text / tool_use 块）。 */
export interface QwenAssistantRow {
  readonly row: "assistant";
  readonly messageId?: string;
  readonly blocks: readonly QwenContentBlock[];
}

/** user：工具结果回填（tool_result 块）。 */
export interface QwenUserRow {
  readonly row: "user";
  readonly blocks: readonly QwenContentBlock[];
}

/** result 的 usage（snake_case 原样收窄）。 */
export interface QwenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly totalTokens?: number;
}

/** result.permission_denials[] 条目（结构化被拒清单，调研 §3.4）。 */
export interface QwenPermissionDenial {
  readonly toolName?: string;
  readonly toolUseId?: string;
}

/** result：末行。subtype=success 且 is_error=false **不等于成功**（调研 §8 坑 1/2）。 */
export interface QwenResultRow {
  readonly row: "result";
  readonly subtype?: string;
  readonly isError: boolean;
  readonly resultText?: string;
  readonly errorMessage?: string;
  readonly usage?: QwenUsage;
  readonly numTurns?: number;
  readonly permissionDenials: readonly QwenPermissionDenial[];
}

/** 收窄后的信封行。 */
export type QwenStreamRow =
  | QwenInitRow
  | QwenStreamEventRow
  | QwenAssistantRow
  | QwenUserRow
  | QwenResultRow;

function parseContentBlock(value: unknown): QwenContentBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { block: "unknown", native: value };
  }
  const source = value as Record<string, unknown>;
  const type = readString(source, "type");
  switch (type) {
    case "text":
    case "thinking": {
      const text = readString(source, type === "thinking" ? "thinking" : "text");
      return text === undefined ? { block: "unknown", native: value } : { block: type, text };
    }
    case "tool_use": {
      const name = readString(source, "name");
      if (name === undefined) {
        return { block: "unknown", native: value };
      }
      return {
        block: "tool_use",
        name,
        ...optional("id", readString(source, "id")),
        input: readObject(source, "input") ?? {},
      };
    }
    case "tool_result": {
      // content 观测为字符串（真机 fixture）；对象/数组形态按 unknown 处理不硬解。
      const content = readString(source, "content");
      return {
        block: "tool_result",
        ...optional("toolUseId", readString(source, "tool_use_id")),
        isError: source["is_error"] === true,
        ...optional("content", content),
      };
    }
    default:
      return { block: "unknown", native: value };
  }
}

function parseUsage(source: Readonly<Record<string, unknown>>): QwenUsage | undefined {
  const usage = readObject(source, "usage");
  if (usage === undefined) {
    return undefined;
  }
  const narrowed: QwenUsage = {
    ...optional("inputTokens", readNumber(usage, "input_tokens")),
    ...optional("outputTokens", readNumber(usage, "output_tokens")),
    ...optional("cachedInputTokens", readNumber(usage, "cache_read_input_tokens")),
    ...optional("totalTokens", readNumber(usage, "total_tokens")),
  };
  return Object.keys(narrowed).length === 0 ? undefined : narrowed;
}

function parseMessageBlocks(source: Readonly<Record<string, unknown>>): {
  readonly messageId?: string;
  readonly blocks: readonly QwenContentBlock[];
} {
  const message = readObject(source, "message");
  if (message === undefined) {
    return { blocks: [] };
  }
  const content = readArray(message, "content") ?? [];
  return {
    ...optional("messageId", readString(message, "id")),
    blocks: content.map(parseContentBlock),
  };
}

/**
 * 收窄一行已解析的 stream-json 信封。
 * 返回 undefined 表示"类型未知或必填字段缺失"，调用方应转 raw 事件而不是丢弃。
 */
export function parseQwenStreamRow(
  value: Readonly<Record<string, unknown>>,
): QwenStreamRow | undefined {
  const type = value["type"];
  if (!isQwenStreamRowType(type)) {
    return undefined;
  }
  switch (type) {
    case "system": {
      if (readString(value, "subtype") !== "init") {
        // 其余 system subtype（将来扩展）走 raw 留档。
        return undefined;
      }
      return {
        row: "init",
        ...optional("sessionId", readString(value, "session_id")),
        ...optional("model", readString(value, "model")),
        ...optional("permissionMode", readString(value, "permission_mode")),
        ...optional("version", readString(value, "qwen_code_version")),
      };
    }
    case "stream_event": {
      const event = readObject(value, "event");
      if (event === undefined) {
        return undefined;
      }
      return {
        row: "stream_event",
        ...optional("eventType", readString(event, "type")),
        event,
      };
    }
    case "assistant": {
      const { messageId, blocks } = parseMessageBlocks(value);
      return { row: "assistant", ...optional("messageId", messageId), blocks };
    }
    case "user": {
      const { blocks } = parseMessageBlocks(value);
      return { row: "user", blocks };
    }
    case "result": {
      const error = readObject(value, "error");
      const denials = (readArray(value, "permission_denials") ?? []).flatMap(
        (entry): QwenPermissionDenial[] => {
          if (typeof entry !== "object" || entry === null) {
            return [];
          }
          const record = entry as Record<string, unknown>;
          return [
            {
              ...optional("toolName", readString(record, "tool_name")),
              ...optional("toolUseId", readString(record, "tool_use_id")),
            },
          ];
        },
      );
      return {
        row: "result",
        ...optional("subtype", readString(value, "subtype")),
        isError: value["is_error"] === true,
        ...optional("resultText", readString(value, "result")),
        ...optional("errorMessage", error === undefined ? undefined : readString(error, "message")),
        ...optional("usage", parseUsage(value)),
        ...optional("numTurns", readNumber(value, "num_turns")),
        permissionDenials: denials,
      };
    }
  }
}
