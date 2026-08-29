/**
 * Gemini CLI `-o stream-json` 六类原生事件的读取与收窄（W2.5）。
 *
 * 权威依据：docs/adapters/gemini-cli.md §3.2 的事件表 + 本机 0.57.0 安装包源码
 * （`bundle/gemini-*.js` 的 `emitEvent({ type: ... })` 调用点、
 * `bundle/docs/reference/tools.md` 的 "Tool argument keys" 表）。
 *
 * 本模块只做"原生 JSON → 收窄后的原生形状"，不涉及统一事件语义（那是 events.ts）：
 * 字段一律按"可缺席"处理，形状不认识就返回 undefined，由映射器转 raw 事件上交
 * （调研 §8.4 坑 8：tool_id 等字段格式不保证；事件词汇会随版本漂移）。
 */

import type { RuntimeId } from "@ff-pane/shared";
import { createLiteralGuard } from "@ff-pane/shared";

/** 本适配器的 Runtime 注册键（KNOWN_RUNTIMES 之一）。 */
export const GEMINI_CLI_RUNTIME: RuntimeId = "gemini-cli";

/** stream-json 的六类事件判别值（调研 §3.2）。 */
export const GEMINI_STREAM_EVENT_TYPES = [
  "init",
  "message",
  "tool_use",
  "tool_result",
  "error",
  "result",
] as const;

/** stream-json 事件类型。 */
export type GeminiStreamEventType = (typeof GEMINI_STREAM_EVENT_TYPES)[number];

/** GeminiStreamEventType 运行时守卫。 */
export const isGeminiStreamEventType = createLiteralGuard(GEMINI_STREAM_EVENT_TYPES);

/**
 * 文件编辑类工具名（参数键 file_path，调研 §3.2「文件修改如何体现」）。
 * write_file 另有 content，replace 另有 old_string/new_string。
 */
export const GEMINI_EDIT_TOOL_NAMES = ["write_file", "replace"] as const;

/** 命令执行工具名（参数键 command / description / dir_path / is_background）。 */
export const GEMINI_SHELL_TOOL_NAME = "run_shell_command";

/** 联网类工具名（参数键分别为 query / prompt，来自 0.57.0 tools.md 参数键表）。 */
export const GEMINI_NETWORK_TOOL_NAMES = ["google_web_search", "web_fetch"] as const;

/**
 * "被策略拒绝"的 tool_result 错误类型。
 *
 * 两个取值都要认：
 * - `policy_violation` —— 调度器路径 `getPolicyDenialError()` 的 errorType
 *   （0.57.0 源码字面量，附带 `denyMessage`），是 `--policy` 规则拒绝的实际取值；
 * - `permission_denied` —— ToolErrorType.PERMISSION_DENIED，工具自身报的权限失败
 *   （如写文件 EACCES），W2.1b 移交要点也以此为 headless 静默失败信号。
 *
 * 另有一条工具基类路径直接 `throw new Error('Tool execution for "X" denied by policy.')`，
 * 该路径的 errorType 会退化为 TOOL_EXECUTION_ERROR，故再补一条消息文本兜底判据。
 */
export const GEMINI_DENIAL_ERROR_TYPES = ["policy_violation", "permission_denied"] as const;

/** 拒绝消息兜底判据（源码字面量 `denied by policy.`）。 */
export const GEMINI_DENIAL_MESSAGE_PATTERN = /denied by policy/i;

/** init：首个事件，携带会话 ID 与"配置值"模型名。 */
export interface GeminiInitEvent {
  readonly type: "init";
  readonly sessionId?: string;
  /**
   * 配置值而非实际模型（调研 §8.4 坑 7：`-m auto` 时此处就是 "auto"）。
   * 映射器**不得**把它当作 SessionStartEvent.model 上报。
   */
  readonly model?: string;
}

/** message：用户输入回显（无 delta）或 assistant 增量文本块（delta: true）。 */
export interface GeminiMessageEvent {
  readonly type: "message";
  readonly role: string;
  readonly content: string;
  readonly delta: boolean;
}

/** tool_use：工具调用请求（已过策略检查，headless 无中途审批）。 */
export interface GeminiToolUseEvent {
  readonly type: "tool_use";
  readonly toolName: string;
  readonly toolId?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** tool_result：工具结果。**没有任何结构化退出码字段**（调研 §7 能力 4）。 */
export interface GeminiToolResultEvent {
  readonly type: "tool_result";
  readonly toolId?: string;
  readonly status: "success" | "error";
  readonly output?: string;
  readonly errorType?: string;
  readonly errorMessage?: string;
}

/** error：非致命告警（配额重试、流校验失败等）。致命错误不走此事件而是非零退出。 */
export interface GeminiErrorEvent {
  readonly type: "error";
  readonly severity: "warning" | "error";
  readonly message: string;
}

/** result 事件的简化统计（源码 `convertToStreamStats()`）。 */
export interface GeminiStreamStats {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly durationMs?: number;
  readonly toolCalls?: number;
}

/** result：末事件。**不含最终完整文本**（调研 §8.4 坑 4）。 */
export interface GeminiResultEvent {
  readonly type: "result";
  readonly status: "success" | "error";
  readonly errorMessage?: string;
  readonly stats?: GeminiStreamStats;
}

/** 收窄后的原生事件。 */
export type GeminiStreamEvent =
  | GeminiInitEvent
  | GeminiMessageEvent
  | GeminiToolUseEvent
  | GeminiToolResultEvent
  | GeminiErrorEvent
  | GeminiResultEvent;

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

function optional<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined,
): Record<TKey, TValue> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<TKey, TValue>);
}

function parseStats(source: Readonly<Record<string, unknown>>): GeminiStreamStats | undefined {
  const stats = readObject(source, "stats");
  if (stats === undefined) {
    return undefined;
  }
  return {
    ...optional("totalTokens", readNumber(stats, "total_tokens")),
    ...optional("inputTokens", readNumber(stats, "input_tokens")),
    ...optional("outputTokens", readNumber(stats, "output_tokens")),
    ...optional("cachedTokens", readNumber(stats, "cached")),
    ...optional("durationMs", readNumber(stats, "duration_ms")),
    ...optional("toolCalls", readNumber(stats, "tool_calls")),
  };
}

/**
 * 收窄一行已解析的 stream-json 事件。
 * 返回 undefined 表示"类型未知或必填字段缺失"，调用方应转 raw 事件而不是丢弃。
 */
export function parseGeminiStreamEvent(
  value: Readonly<Record<string, unknown>>,
): GeminiStreamEvent | undefined {
  const type = value["type"];
  if (!isGeminiStreamEventType(type)) {
    return undefined;
  }
  switch (type) {
    case "init":
      return {
        type,
        ...optional("sessionId", readString(value, "session_id")),
        ...optional("model", readString(value, "model")),
      };
    case "message": {
      const role = readString(value, "role");
      const content = readString(value, "content");
      if (role === undefined || content === undefined) {
        return undefined;
      }
      return { type, role, content, delta: value["delta"] === true };
    }
    case "tool_use": {
      const toolName = readString(value, "tool_name");
      if (toolName === undefined) {
        return undefined;
      }
      return {
        type,
        toolName,
        ...optional("toolId", readString(value, "tool_id")),
        parameters: readObject(value, "parameters") ?? {},
      };
    }
    case "tool_result": {
      const rawStatus = readString(value, "status");
      if (rawStatus !== "success" && rawStatus !== "error") {
        return undefined;
      }
      const error = readObject(value, "error");
      return {
        type,
        status: rawStatus,
        ...optional("toolId", readString(value, "tool_id")),
        ...optional("output", readString(value, "output")),
        ...optional("errorType", error === undefined ? undefined : readString(error, "type")),
        ...optional("errorMessage", error === undefined ? undefined : readString(error, "message")),
      };
    }
    case "error": {
      const message = readString(value, "message");
      if (message === undefined) {
        return undefined;
      }
      return {
        type,
        severity: readString(value, "severity") === "warning" ? "warning" : "error",
        message,
      };
    }
    case "result": {
      const rawStatus = readString(value, "status");
      if (rawStatus !== "success" && rawStatus !== "error") {
        return undefined;
      }
      const error = readObject(value, "error");
      return {
        type,
        status: rawStatus,
        ...optional("errorMessage", error === undefined ? undefined : readString(error, "message")),
        ...optional("stats", parseStats(value)),
      };
    }
  }
}

/** tool_result 是否为"被策略拒绝"（headless 静默失败的唯一信号，调研 §8.4 坑 1）。 */
export function isGeminiPolicyDenial(event: GeminiToolResultEvent): boolean {
  if (event.status !== "error") {
    return false;
  }
  const denialTypes: readonly string[] = GEMINI_DENIAL_ERROR_TYPES;
  if (event.errorType !== undefined && denialTypes.includes(event.errorType)) {
    return true;
  }
  return GEMINI_DENIAL_MESSAGE_PATTERN.test(`${event.errorMessage ?? ""}\n${event.output ?? ""}`);
}

/** 是否为文件编辑类工具。 */
export function isGeminiEditTool(toolName: string): boolean {
  const editTools: readonly string[] = GEMINI_EDIT_TOOL_NAMES;
  return editTools.includes(toolName);
}
