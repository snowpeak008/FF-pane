/**
 * Gemini CLI stream-json → 统一 AgentEvent 映射器（W2.5，纯函数 + 显式状态机）。
 *
 * 只吃 stdout 的 JSONL（调研 §3.3：stderr 噪音大且含堆栈，全量留档不参与解析），
 * 一行进、零到多条统一事件出；进程终局单独经 finish() 收尾。**end 事件只在 finish()
 * 产出**，理由是 gemini 的 `result` 事件先于进程退出到达，而退出码本身是判据
 * （41 认证 / 55 未信任 / API 错误透传 HTTP 状态码，调研 §2），推迟到退出才能把
 * "result 语义 + 退出码语义"合成一条 end，同时天然满足"恰好一条 end 收尾"。
 *
 * 五条来自 W2.1b/调研的硬性映射规则：
 * 1. assistant 文本是 `delta: true` 增量块，流里**没有**最终完整文本事件 →
 *    每块 final: false，`result` 到达时补一条 content 为空的 final（events/types.ts
 *    对 TextEvent 的约定）；
 * 2. `role: "user"` 的回显直接丢弃（那是我们自己发出去的 prompt）；
 * 3. tool_result **无退出码字段** → CommandEvent.exitCode 一律缺席，成败只由 status 承载；
 * 4. 被策略拒绝的 tool_result 是 headless 静默失败的唯一信号（进程仍退 0、result 仍 success，
 *    调研 §8.4 坑 1）→ 动作状态记 denied，并把整轮 end 上浮为 failed；
 * 5. `init.model` 是配置别名（"auto"）不是实际模型 → **不填** SessionStartEvent.model。
 */

import type { NativeSessionId, RunEndReason } from "@ff-pane/shared";
import type { AgentEvent, FileChangeKind, JsonlRecord, TokenUsage } from "../events/index.js";
import { toRawEvent } from "../events/index.js";
import type { AgentProcessEndKind } from "../process/index.js";
import { describeGeminiExitCode, GEMINI_EXIT_CANCELLED, GEMINI_EXIT_OK } from "./exit-codes.js";
import type { GeminiResultEvent, GeminiToolResultEvent, GeminiToolUseEvent } from "./native.js";
import {
  GEMINI_CLI_RUNTIME,
  GEMINI_SHELL_TOOL_NAME,
  isGeminiEditTool,
  isGeminiPolicyDenial,
  parseGeminiStreamEvent,
} from "./native.js";

/** 映射器构造参数。 */
export interface GeminiEventMapperOptions {
  /** 本轮工作目录（NativeSessionBinding 的另一半，会话按 cwd 隔离，调研 §4）。 */
  readonly cwd: string;
  /**
   * 启动时经 `--session-id` 预生成并登记的 UUID（调研 §4）。
   * 给了它，init 事件就只用于校验；没给（如 resume）则以 init 报出的为准。
   */
  readonly sessionId?: string;
}

/** 进程终局（finish() 的输入；字段取自 W2.1a 的 AgentProcessExit + 取消意图）。 */
export interface GeminiTurnOutcome {
  readonly endKind: AgentProcessEndKind;
  readonly exitCode: number | null;
  /** 是否由 FF-pane 主动取消（cancel() 被调用过）。 */
  readonly cancelRequested: boolean;
  /** 进程级错误说明（spawn 失败等），无则 null/缺席。 */
  readonly processError?: string | null;
}

/** 有状态映射器：单轮专用，不可跨轮复用。 */
export interface GeminiEventMapper {
  /** 映射一行原生记录（含脏行）；返回 0..n 条统一事件。 */
  map(record: JsonlRecord): readonly AgentEvent[];
  /** 收尾：按 result 语义 + 退出码语义合成恰好一条 end（必要时先补 final 文本）。 */
  finish(outcome: GeminiTurnOutcome): readonly AgentEvent[];
  /** 已确认的原生会话 ID（登记用；init 未到达且未预生成时为 undefined）。 */
  nativeSessionId(): string | undefined;
}

/** 未归类原生事件的 raw 注记前缀（便于在 Run 原始日志里检索）。 */
export const GEMINI_RAW_NOTE_UNMAPPED = "gemini-cli：未归入六类骨架的原生事件";

/** stderr 行的 raw 注记（调研 §3.3：只留档不解析）。 */
export const GEMINI_RAW_NOTE_STDERR = "gemini-cli stderr（不参与事件解析，仅留档）";

/** 统一 diff 文本的识别特征（jsdiff createPatch 的表头/hunk 头）。 */
const UNIFIED_DIFF_HINT = /^(?:Index: |--- |\+\+\+ |@@ )/m;

/** 新建文件的 hunk 头（原文件 0 行）——write_file 的 add/update 判据。 */
const NEW_FILE_HUNK = /^@@ -0,0 /m;

interface PendingTool {
  readonly toolName: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

function readStringParam(
  parameters: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = parameters[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * `tool_result.output` 是否是可用的统一 diff（调研 §3.2：edit 类工具成功时为
 * jsdiff createPatch 文本）。不像 diff 就缺席——**不自造 diff**：write_file 只给得到
 * 新内容，旧内容无从得知，凭空拼出的 diff 是伪造事实（events/types.ts 的约定）。
 */
function extractDiff(output: string | undefined): string | undefined {
  return output !== undefined && UNIFIED_DIFF_HINT.test(output) ? output : undefined;
}

function inferChangeKind(toolName: string, diff: string | undefined): FileChangeKind {
  if (toolName !== "write_file") {
    // replace 按定义是就地改写；其余编辑类工具未知时同样按 update 处理。
    return "update";
  }
  return diff !== undefined && NEW_FILE_HUNK.test(diff) ? "add" : "update";
}

function toUsage(result: GeminiResultEvent | undefined): TokenUsage | undefined {
  const stats = result?.stats;
  if (stats === undefined) {
    return undefined;
  }
  const usage: TokenUsage = {
    ...(stats.inputTokens === undefined ? {} : { inputTokens: stats.inputTokens }),
    ...(stats.outputTokens === undefined ? {} : { outputTokens: stats.outputTokens }),
    ...(stats.cachedTokens === undefined ? {} : { cachedInputTokens: stats.cachedTokens }),
    ...(stats.totalTokens === undefined ? {} : { totalTokens: stats.totalTokens }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/** 创建单轮映射器。 */
export function createGeminiEventMapper(options: GeminiEventMapperOptions): GeminiEventMapper {
  /** tool_use → tool_result 配对表。key 为 tool_id（缺席时用空串，见调研 §8.4 坑 8）。 */
  const pending = new Map<string, PendingTool>();
  /** 当前 assistant 消息是否还开着（收到过 delta 但尚未补 final）。 */
  let textOpen = false;
  /** 被策略拒绝的工具名（headless 静默失败取证）。 */
  const denials: string[] = [];
  /** 非致命 error 事件的消息（末尾并入 end.message，调研 §8.1）。 */
  const warnings: string[] = [];
  let sessionId = options.sessionId;
  let result: GeminiResultEvent | undefined;

  function closeText(): readonly AgentEvent[] {
    if (!textOpen) {
      return [];
    }
    textOpen = false;
    // 空 content 的纯收尾信号（events/types.ts 对 TextEvent.final 的约定）。
    return [{ kind: "text", content: "", final: true, channel: "answer" }];
  }

  function mapToolUse(event: GeminiToolUseEvent): readonly AgentEvent[] {
    const key = event.toolId ?? "";
    pending.set(key, { toolName: event.toolName, parameters: event.parameters });
    const actionId = event.toolId === undefined ? {} : { actionId: event.toolId };

    if (isGeminiEditTool(event.toolName)) {
      const path = readStringParam(event.parameters, "file_path");
      if (path === undefined) {
        return [toRawEvent(GEMINI_CLI_RUNTIME, event, "tool_use 缺 parameters.file_path")];
      }
      return [
        {
          kind: "file_change",
          path,
          changeKind: inferChangeKind(event.toolName, undefined),
          status: "started",
          ...actionId,
        },
      ];
    }
    if (event.toolName === GEMINI_SHELL_TOOL_NAME) {
      const command = readStringParam(event.parameters, "command");
      if (command === undefined) {
        return [toRawEvent(GEMINI_CLI_RUNTIME, event, "tool_use 缺 parameters.command")];
      }
      const cwd = readStringParam(event.parameters, "dir_path");
      return [
        {
          kind: "command",
          command,
          status: "started",
          ...(cwd === undefined ? {} : { cwd }),
          ...actionId,
        },
      ];
    }
    // 只读工具（glob/read_file/grep_search…）噪音大且不属六类骨架：进 raw 留档，
    // 由上层折叠为进度提示（调研 §8.1 映射表最后一行）。
    return [toRawEvent(GEMINI_CLI_RUNTIME, event, `${GEMINI_RAW_NOTE_UNMAPPED}（只读工具调用）`)];
  }

  function mapToolResult(event: GeminiToolResultEvent): readonly AgentEvent[] {
    const key = event.toolId ?? "";
    const started = pending.get(key);
    pending.delete(key);
    if (started === undefined) {
      return [
        toRawEvent(
          GEMINI_CLI_RUNTIME,
          event,
          "tool_result 无法与任何 tool_use 配对（tool_id 不匹配）",
        ),
      ];
    }

    const denied = isGeminiPolicyDenial(event);
    if (denied) {
      denials.push(started.toolName);
    }
    const status = denied ? "denied" : event.status === "error" ? "failed" : "completed";
    const actionId = event.toolId === undefined ? {} : { actionId: event.toolId };

    if (isGeminiEditTool(started.toolName)) {
      const path = readStringParam(started.parameters, "file_path") ?? "";
      const diff = extractDiff(event.output);
      return [
        {
          kind: "file_change",
          path,
          changeKind: inferChangeKind(started.toolName, diff),
          status,
          ...(diff === undefined ? {} : { diff }),
          ...actionId,
        },
      ];
    }
    if (started.toolName === GEMINI_SHELL_TOOL_NAME) {
      const cwd = readStringParam(started.parameters, "dir_path");
      return [
        {
          kind: "command",
          command: readStringParam(started.parameters, "command") ?? "",
          status,
          // exitCode 恒缺席：gemini 的 tool_result 没有结构化退出码（调研 §7 能力 4）。
          ...(event.output === undefined ? {} : { output: event.output }),
          ...(cwd === undefined ? {} : { cwd }),
          ...actionId,
        },
      ];
    }
    return [
      toRawEvent(
        GEMINI_CLI_RUNTIME,
        event,
        `${GEMINI_RAW_NOTE_UNMAPPED}（只读工具结果，tool_name=${started.toolName}）`,
      ),
    ];
  }

  return {
    map(record: JsonlRecord): readonly AgentEvent[] {
      if (!record.ok) {
        return [toRawEvent(GEMINI_CLI_RUNTIME, record.raw, record.reason)];
      }
      const event = parseGeminiStreamEvent(record.value);
      if (event === undefined) {
        return [toRawEvent(GEMINI_CLI_RUNTIME, record.value, GEMINI_RAW_NOTE_UNMAPPED)];
      }
      switch (event.type) {
        case "init": {
          if (event.sessionId !== undefined) {
            sessionId = event.sessionId;
          }
          // model 故意不填：init.model 是配置别名（见文件头规则 5）。
          return [
            {
              kind: "session_start",
              ...(sessionId === undefined
                ? {}
                : {
                    native: {
                      nativeSessionId: sessionId as NativeSessionId,
                      cwd: options.cwd,
                    },
                  }),
            },
          ];
        }
        case "message": {
          if (event.role !== "assistant") {
            // 用户输入回显丢弃（文件头规则 2）。
            return [];
          }
          if (event.delta) {
            textOpen = true;
            return [{ kind: "text", content: event.content, final: false, channel: "answer" }];
          }
          // 非增量的 assistant 消息（未来版本可能出现）：整条即完整消息，直接收尾。
          textOpen = false;
          return [{ kind: "text", content: event.content, final: true, channel: "answer" }];
        }
        case "tool_use":
          return mapToolUse(event);
        case "tool_result":
          return mapToolResult(event);
        case "error":
          // 非致命告警：不进 text（那会把 CLI 诊断混成模型的正式回答），
          // 留档 raw 并在 end.message 里并入原因（调研 §8.1 最后一行）。
          warnings.push(`[${event.severity}] ${event.message}`);
          return [
            toRawEvent(
              GEMINI_CLI_RUNTIME,
              event,
              `gemini-cli 非致命告警（severity=${event.severity}）`,
            ),
          ];
        case "result":
          result = event;
          return closeText();
      }
    },

    finish(outcome: GeminiTurnOutcome): readonly AgentEvent[] {
      const events: AgentEvent[] = [...closeText()];
      const cancelled =
        outcome.cancelRequested ||
        outcome.endKind === "timeout" ||
        outcome.exitCode === GEMINI_EXIT_CANCELLED;

      let reason: RunEndReason;
      if (cancelled) {
        reason = "cancelled";
      } else if (outcome.endKind === "spawn-failed" || outcome.endKind === "killed") {
        // 没起来 / 被外力杀掉：流断而无终止事件，按 events/types.ts 的兜底约定记 crashed。
        reason = "crashed";
      } else if (denials.length > 0) {
        // 被策略拒绝就是任务失败，与 result/退出码怎么说无关（文件头规则 4）。
        reason = "failed";
      } else if (result === undefined) {
        reason = outcome.exitCode === GEMINI_EXIT_OK ? "completed" : "failed";
      } else if (
        result.status === "error" ||
        (outcome.exitCode ?? GEMINI_EXIT_OK) !== GEMINI_EXIT_OK
      ) {
        reason = "failed";
      } else {
        reason = "completed";
      }

      const parts: string[] = [];
      if (result?.errorMessage !== undefined) {
        parts.push(result.errorMessage);
      }
      if (denials.length > 0) {
        parts.push(
          `headless 静默失败：以下工具被策略拒绝（Gemini CLI 非交互模式无审批通道，` +
            `拒绝不影响进程退出码）：${[...new Set(denials)].join("、")}`,
        );
      }
      if (result === undefined && !cancelled && outcome.endKind === "exited") {
        parts.push("事件流未出现 result 事件（stdout 可能被截断，或 CLI 在开流前就已致命失败）");
      }
      // 取消场景不解释退出码：那时的退出码来自我们的树杀（Windows taskkill 常给 1），
      // 不是 CLI 自己的语义，硬翻译反而误导。
      const exitDescription = cancelled ? undefined : describeGeminiExitCode(outcome.exitCode);
      if (exitDescription !== undefined) {
        parts.push(exitDescription);
      }
      if (outcome.processError !== undefined && outcome.processError !== null) {
        parts.push(outcome.processError);
      }
      parts.push(...warnings);

      const usage = toUsage(result);
      events.push({
        kind: "end",
        reason,
        ...(usage === undefined ? {} : { usage }),
        ...(parts.length === 0 ? {} : { message: parts.join("\n") }),
        ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
      });
      return events;
    },

    nativeSessionId(): string | undefined {
      return sessionId;
    },
  };
}
