/**
 * Qwen Code stream-json → 统一 AgentEvent 映射器（T8.6a，纯函数 + 显式状态机）。
 *
 * 只吃 stdout 的 JSONL（stderr 只留档不解析，调研 §3.3），一行进、零到多条统一
 * 事件出；进程终局单独经 finish() 收尾。**end 事件只在 finish() 产出**——result
 * 行先于进程退出到达，推迟合成才能把「result 语义 + 三坑防线 + 进程终局」收进
 * 恰好一条 end。
 *
 * 五条来自调研（docs/adapters/qwen-code.md）的硬性映射规则：
 * 1. 文本只走 stream_event 增量一路（恒开 --include-partial-messages），assistant
 *    行的 text 块与增量**内容完全重复**（§8 坑 7，claude 同款）→ assistant 行只取
 *    tool_use 块，text/thinking 块忽略；
 * 2. `result.permission_denials` 非空 → 整轮 failed（结构化判据；被拒动作另按
 *    tool_result 文本改判 denied）——「权限拒绝伪装成功」防线（§8 坑 2）；
 * 3. 文本命中 `[API Error:` → 整轮 failed（qwen 把 API 错误升格为 assistant 文本后
 *    照常 result(success)/退出 0，§8 坑 1——比 gemini 恶劣，连退出码信号都没有）；
 * 4. **result 已到达时退出码不参与成败判定**：Windows 退出期偶发 libuv 断言崩溃
 *    （0xC0000409，§8 坑 3），发生在 result 完整落出之后——照 gemini 的
 *    「非零退出码 → failed」抄会把成功轮误判失败。result 缺席时退出码照常兜底；
 * 5. init.model 是启动参数回显（"-m" 的值原样）非实际解析值 → 不填
 *    SessionStartEvent.model（gemini 同款规则）。
 */

import type { NativeSessionId, RunEndReason } from "@ff-pane/shared";
import type {
  AgentActionStatus,
  AgentEvent,
  FileChangeKind,
  JsonlRecord,
  TextChannel,
  TokenUsage,
} from "../events/index.js";
import { toRawEvent } from "../events/index.js";
import type { AgentProcessEndKind } from "../process/index.js";
import type { QwenContentBlock, QwenResultRow, QwenStreamEventRow } from "./native.js";
import {
  isQwenDenialText,
  isQwenEditTool,
  parseQwenStreamRow,
  QWEN_API_ERROR_MARKER,
  QWEN_CODE_RUNTIME,
  QWEN_SHELL_TOOL_NAME,
} from "./native.js";

/** 映射器构造参数。 */
export interface QwenEventMapperOptions {
  /** 本轮工作目录（NativeSessionBinding 的另一半，会话按 cwd 隔离，调研 §4）。 */
  readonly cwd: string;
  /**
   * 启动时经 `--session-id` 预生成并登记的 UUID（调研 §4）。
   * 给了它，init 行就只用于校验；没给（如 resume）则以 init 报出的为准。
   */
  readonly sessionId?: string;
}

/** 进程终局（finish() 的输入）。 */
export interface QwenTurnOutcome {
  readonly endKind: AgentProcessEndKind;
  readonly exitCode: number | null;
  /** 是否由 FF-pane 主动取消（cancel() 被调用过）。 */
  readonly cancelRequested: boolean;
  /** 进程级错误说明（spawn 失败等），无则 null/缺席。 */
  readonly processError?: string | null;
}

/** 有状态映射器：单轮专用，不可跨轮复用。 */
export interface QwenEventMapper {
  /** 映射一行原生记录（含脏行）；返回 0..n 条统一事件。 */
  map(record: JsonlRecord): readonly AgentEvent[];
  /** 收尾：按 result 语义 + 三坑防线 + 进程终局合成恰好一条 end。 */
  finish(outcome: QwenTurnOutcome): readonly AgentEvent[];
  /** 已确认的原生会话 ID（登记用）。 */
  nativeSessionId(): string | undefined;
}

/** 未归类原生行的 raw 注记前缀。 */
export const QWEN_RAW_NOTE_UNMAPPED = "qwen-code：未归入六类骨架的原生行";

/** stderr 行的 raw 注记（调研 §3.3：只留档不解析）。 */
export const QWEN_RAW_NOTE_STDERR = "qwen-code stderr（不参与事件解析，仅留档）";

interface PendingTool {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

function readStringInput(
  input: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * edit 工具的 diff 渲染：old_string/new_string 是**文件片段**（非全文），渲染为
 * 单 hunk 的替换视图（行号未知故 hunk 头用 @@ -1 +1 @@ 占位语义，事实是「这段换成
 * 那段」）。write_file 不渲染：旧内容不可得（覆盖场景），凭空拼 diff 是伪造事实
 * （events/types.ts 约定；能力声明 fileChangeEvents=partial 的原因之一）。
 */
export function renderQwenEditDiff(oldText: string, newText: string): string | undefined {
  if (oldText === newText) {
    return undefined;
  }
  const toLines = (text: string): string[] => (text === "" ? [] : text.split("\n"));
  const removed = toLines(oldText).map((line) => `-${line}`);
  const added = toLines(newText).map((line) => `+${line}`);
  return [`@@ -1,${removed.length} +1,${added.length} @@`, ...removed, ...added].join("\n");
}

function toUsage(result: QwenResultRow | undefined): TokenUsage | undefined {
  const usage = result?.usage;
  if (usage === undefined) {
    return undefined;
  }
  const narrowed: TokenUsage = {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
  };
  return Object.keys(narrowed).length === 0 ? undefined : narrowed;
}

/** 创建单轮映射器。 */
export function createQwenEventMapper(options: QwenEventMapperOptions): QwenEventMapper {
  /** tool_use_id → 工具名与入参（tool_result 到达时配对；缺 id 用空串键）。 */
  const pending = new Map<string, PendingTool>();
  /** content block index → 文本通道（delta 无类型信息，从 content_block_start 记）。 */
  const blockChannels = new Map<number, TextChannel>();
  /** 当前流式文本块是否开着（收过 delta 未补 final）。 */
  let openChannel: TextChannel | undefined;
  /** API 错误文本标记命中（规则 3）。 */
  let sawApiErrorMarker = false;
  let sessionId = options.sessionId;
  let result: QwenResultRow | undefined;

  function closeText(): readonly AgentEvent[] {
    if (openChannel === undefined) {
      return [];
    }
    const channel = openChannel;
    openChannel = undefined;
    // 空 content 的纯收尾信号（events/types.ts 对 TextEvent.final 的约定）。
    return [{ kind: "text", content: "", final: true, channel }];
  }

  function mapStreamEvent(row: QwenStreamEventRow): readonly AgentEvent[] {
    const event = row.event;
    switch (row.eventType) {
      case "content_block_start": {
        const index = typeof event["index"] === "number" ? (event["index"] as number) : 0;
        const block = event["content_block"];
        const blockType =
          typeof block === "object" && block !== null
            ? (block as Record<string, unknown>)["type"]
            : undefined;
        if (blockType === "text") {
          blockChannels.set(index, "answer");
        } else if (blockType === "thinking") {
          blockChannels.set(index, "reasoning");
        }
        return [];
      }
      case "content_block_delta": {
        const index = typeof event["index"] === "number" ? (event["index"] as number) : 0;
        const delta = event["delta"];
        if (typeof delta !== "object" || delta === null) {
          return [];
        }
        const record = delta as Record<string, unknown>;
        const deltaType = record["type"];
        const text =
          deltaType === "text_delta"
            ? record["text"]
            : deltaType === "thinking_delta"
              ? record["thinking"]
              : undefined;
        if (typeof text !== "string") {
          // input_json_delta（tool_use 参数分片）等：参数以 assistant 行的完整块为准。
          return [];
        }
        if (text.includes(QWEN_API_ERROR_MARKER)) {
          sawApiErrorMarker = true;
        }
        const channel = blockChannels.get(index) ?? "answer";
        openChannel = channel;
        return [{ kind: "text", content: text, final: false, channel }];
      }
      case "content_block_stop":
      case "message_stop":
        return closeText();
      default:
        // goal_state / message_start 等非骨架事件：raw 留档（调研 §8 坑 8）。
        return [
          toRawEvent(
            QWEN_CODE_RUNTIME,
            row.event,
            `${QWEN_RAW_NOTE_UNMAPPED}（stream_event: ${row.eventType ?? "?"}）`,
          ),
        ];
    }
  }

  function mapToolUse(block: Extract<QwenContentBlock, { block: "tool_use" }>): AgentEvent[] {
    const key = block.id ?? "";
    pending.set(key, { toolName: block.name, input: block.input });
    const actionId = block.id === undefined ? {} : { actionId: block.id };

    if (isQwenEditTool(block.name)) {
      const path =
        readStringInput(block.input, "file_path") ?? readStringInput(block.input, "notebook_path");
      if (path === undefined) {
        return [toRawEvent(QWEN_CODE_RUNTIME, block, "tool_use 缺 input.file_path")];
      }
      // edit 有 old/new 片段可渲染 diff；write_file 覆盖场景旧内容不可得，不自造。
      const oldText = readStringInput(block.input, "old_string");
      const newText = readStringInput(block.input, "new_string");
      const diff =
        block.name === "edit" && oldText !== undefined && newText !== undefined
          ? renderQwenEditDiff(oldText, newText)
          : undefined;
      const changeKind: FileChangeKind = block.name === "write_file" ? "add" : "update";
      return [
        {
          kind: "file_change",
          path,
          changeKind,
          status: "started",
          ...(diff === undefined ? {} : { diff }),
          ...actionId,
        },
      ];
    }
    if (block.name === QWEN_SHELL_TOOL_NAME) {
      const command = readStringInput(block.input, "command");
      if (command === undefined) {
        return [toRawEvent(QWEN_CODE_RUNTIME, block, "tool_use 缺 input.command")];
      }
      const cwd = readStringInput(block.input, "dir_path");
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
    // 只读工具（read_file/glob/grep_search…）噪音大且不属六类骨架：raw 留档。
    return [toRawEvent(QWEN_CODE_RUNTIME, block, `${QWEN_RAW_NOTE_UNMAPPED}（只读工具调用）`)];
  }

  function mapToolResult(block: Extract<QwenContentBlock, { block: "tool_result" }>): AgentEvent[] {
    const key = block.toolUseId ?? "";
    const started = pending.get(key);
    pending.delete(key);
    if (started === undefined) {
      return [toRawEvent(QWEN_CODE_RUNTIME, block, "tool_result 无法与任何 tool_use 配对")];
    }
    const denied = block.isError && isQwenDenialText(block.content ?? "");
    const status: AgentActionStatus = denied ? "denied" : block.isError ? "failed" : "completed";
    const actionId = block.toolUseId === undefined ? {} : { actionId: block.toolUseId };

    if (isQwenEditTool(started.toolName)) {
      const path =
        readStringInput(started.input, "file_path") ??
        readStringInput(started.input, "notebook_path") ??
        "";
      const oldText = readStringInput(started.input, "old_string");
      const newText = readStringInput(started.input, "new_string");
      const diff =
        started.toolName === "edit" && oldText !== undefined && newText !== undefined
          ? renderQwenEditDiff(oldText, newText)
          : undefined;
      return [
        {
          kind: "file_change",
          path,
          changeKind: started.toolName === "write_file" ? "add" : "update",
          status,
          ...(diff === undefined ? {} : { diff }),
          ...actionId,
        },
      ];
    }
    if (started.toolName === QWEN_SHELL_TOOL_NAME) {
      const cwd = readStringInput(started.input, "dir_path");
      return [
        {
          kind: "command",
          command: readStringInput(started.input, "command") ?? "",
          status,
          // exitCode 恒缺席：tool_result 无结构化退出码（调研 §3.2，gemini 同款评级）。
          ...(block.content === undefined ? {} : { output: block.content }),
          ...(cwd === undefined ? {} : { cwd }),
          ...actionId,
        },
      ];
    }
    return [
      toRawEvent(
        QWEN_CODE_RUNTIME,
        block,
        `${QWEN_RAW_NOTE_UNMAPPED}（只读工具结果，tool_name=${started.toolName}）`,
      ),
    ];
  }

  return {
    map(record: JsonlRecord): readonly AgentEvent[] {
      if (!record.ok) {
        return [toRawEvent(QWEN_CODE_RUNTIME, record.raw, record.reason)];
      }
      const row = parseQwenStreamRow(record.value);
      if (row === undefined) {
        return [toRawEvent(QWEN_CODE_RUNTIME, record.value, QWEN_RAW_NOTE_UNMAPPED)];
      }
      switch (row.row) {
        case "init": {
          if (row.sessionId !== undefined) {
            sessionId = row.sessionId;
          }
          // model 故意不填：init.model 是启动参数回显（文件头规则 5）。
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
        case "stream_event":
          return mapStreamEvent(row);
        case "assistant": {
          const events: AgentEvent[] = [];
          for (const block of row.blocks) {
            if (block.block === "tool_use") {
              events.push(...mapToolUse(block));
            } else if (block.block === "text" || block.block === "thinking") {
              // 与增量重复（文件头规则 1）：只用于 API 错误标记检测，不产出事件。
              if (block.text.includes(QWEN_API_ERROR_MARKER)) {
                sawApiErrorMarker = true;
              }
            } else {
              events.push(
                toRawEvent(QWEN_CODE_RUNTIME, block, `${QWEN_RAW_NOTE_UNMAPPED}（assistant 块）`),
              );
            }
          }
          return events;
        }
        case "user": {
          const events: AgentEvent[] = [];
          for (const block of row.blocks) {
            if (block.block === "tool_result") {
              events.push(...mapToolResult(block));
            }
            // user 行的其余块（用户输入回显等）丢弃——那是我们自己发出去的。
          }
          return events;
        }
        case "result": {
          result = row;
          if ((row.resultText ?? "").includes(QWEN_API_ERROR_MARKER)) {
            sawApiErrorMarker = true;
          }
          return closeText();
        }
      }
    },

    finish(outcome: QwenTurnOutcome): readonly AgentEvent[] {
      const events: AgentEvent[] = [...closeText()];
      const cancelled = outcome.cancelRequested || outcome.endKind === "timeout";

      let reason: RunEndReason;
      const parts: string[] = [];
      if (cancelled) {
        reason = "cancelled";
      } else if (outcome.endKind === "spawn-failed" || outcome.endKind === "killed") {
        // 没起来 / 被外力杀掉：流断而无终止事件，按 events/types.ts 兜底约定记 crashed。
        reason = "crashed";
      } else if (result === undefined) {
        // result 缺席（流截断）：无从判定成功，退出码此时参与兜底。
        reason = "crashed";
        parts.push("事件流未出现 result 行（stdout 被截断，或 CLI 在开流前就已致命失败）");
      } else if (result.permissionDenials.length > 0) {
        // 规则 2：结构化被拒清单非空 → failed，与 subtype/退出码怎么说无关。
        reason = "failed";
        const denied = [...new Set(result.permissionDenials.map((d) => d.toolName ?? "(unknown)"))];
        parts.push(
          `headless 静默失败：以下工具被审批模式拒绝（Qwen Code 非交互模式无审批通道，` +
            `拒绝不影响退出码与 result.subtype）：${denied.join("、")}`,
        );
      } else if (sawApiErrorMarker) {
        // 规则 3：API 错误升格文本 → failed（result 仍报 success，退出码仍 0）。
        reason = "failed";
        parts.push(
          "API 错误被 Qwen Code 升格为回答文本（result 仍报 success、退出码仍 0）：" +
            (result.resultText ?? "(原文在文本事件中)"),
        );
      } else if (result.isError || (result.subtype !== undefined && result.subtype !== "success")) {
        reason = "failed";
        if (result.errorMessage !== undefined) {
          parts.push(result.errorMessage);
        }
        if (result.subtype !== undefined && result.subtype !== "success") {
          parts.push(`result.subtype = ${result.subtype}`);
        }
      } else {
        // 规则 4：result 已到达且全部防线通过 → completed，退出码不参与判定
        // （Windows 退出期 libuv 崩溃 0xC0000409 发生在 result 落出之后，§8 坑 3）。
        reason = "completed";
      }

      if (outcome.processError !== undefined && outcome.processError !== null) {
        parts.push(outcome.processError);
      }

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
