/**
 * Claude Code stream-json → 统一 AgentEvent 映射器（W2.4）。
 *
 * **无 I/O、无模块级状态**：状态显式外置为 ClaudeCodeMapperState 参数，
 * 同一 (state, 记录序列) 必得同一事件序列——fixture 回放因此可逐条断言，
 * 适配器的进程/协议部分与映射规则各自独立可测。
 *
 * 映射表见 docs/adapters/claude-code.md §9.2，实测坑（§9.3）在此处的落点：
 * 1. 一条消息按 content block 拆多行且共享 message.id → TextEvent.messageId
 *    必填，消费方据此聚合，不重复渲染；
 * 2. `result.permission_denials` 非空时 subtype 仍是 success → 一律不记
 *    completed（resolveEndReason），否则"其实没做"的 Run 会被当成成功；
 * 3. `tool_use_result` 有对象/字符串双形态 → 按 unknown 处理，取不到就缺席；
 * 4. 未知 `system` subtype / `stream_event` / 非 JSON 行 → 一律 raw 上交，
 *    既不丢证据也不中断流。
 *
 * 关于 `--include-partial-messages`：开启后 `stream_event` 的增量与整条
 * `assistant` 行的内容**完全重复**，两路只能选一路（否则 UI 双份、token 统计
 * 翻倍）。本映射器由 partialMessages 开关择一：开 = 只认增量（assistant 的
 * text/thinking 块不再产出事件），关 = 只认整块（stream_event 走 raw 留档）。
 */

import type { NativeSessionId, PermissionRequestPayload, RunEndReason } from "@ff-pane/shared";
import type {
  AgentActionStatus,
  AgentEvent,
  EndEvent,
  FileChangeKind,
  JsonlRecord,
  TextChannel,
  TokenUsage,
} from "../events/index.js";
import { toRawEvent } from "../events/index.js";
import { parseCanUseToolRequest } from "./control.js";
import { formatStructuredPatch } from "./diff.js";
import {
  asArray,
  asNonEmptyString,
  asNumber,
  asObject,
  asObjectArray,
  asString,
  CLAUDE_CODE_RUNTIME,
  CLAUDE_COMMAND_TOOLS,
  CLAUDE_FILE_TOOLS,
  CLAUDE_INTERRUPT_RECEIPT_CAPABILITY,
  CLAUDE_NETWORK_TOOLS,
  CLAUDE_READ_TOOLS,
} from "./native.js";

/** 映射器初始化参数。 */
export interface ClaudeCodeMapperOptions {
  /** 本轮 cwd：`system/init` 未报 cwd 时作为原生会话绑定的兜底值。 */
  readonly cwd: string;
  /** 是否以 `--include-partial-messages` 启动（决定文本走增量还是整块）。 */
  readonly partialMessages?: boolean;
}

/** 已发出但结果未回的工具调用（按 tool_use_id 配对）。 */
interface PendingTool {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** 映射器状态：调用方持有，逐条记录喂入。同一实例不可跨轮复用。 */
export interface ClaudeCodeMapperState {
  readonly cwd: string;
  readonly partialMessages: boolean;
  /** `system/init` 报出的原生会话 ID。 */
  sessionId: string | undefined;
  /** init.capabilities 是否声明 interrupt 控制协议（取消路径的开关）。 */
  interruptReceiptSupported: boolean;
  /** tool_use_id → 工具名与入参（tool_result 到达时取用）。 */
  readonly pendingTools: Map<string, PendingTool>;
  /** content block index → 文本通道（partial 模式下 delta 无类型信息）。 */
  readonly streamBlockChannels: Map<number, TextChannel>;
  /** partial 模式下当前流式消息的 message.id。 */
  streamMessageId: string | undefined;
}

/** 创建映射器状态。 */
export function createClaudeCodeMapperState(
  options: ClaudeCodeMapperOptions,
): ClaudeCodeMapperState {
  return {
    cwd: options.cwd,
    partialMessages: options.partialMessages === true,
    sessionId: undefined,
    interruptReceiptSupported: false,
    pendingTools: new Map<string, PendingTool>(),
    streamBlockChannels: new Map<number, TextChannel>(),
    streamMessageId: undefined,
  };
}

function raw(native: unknown, note: string): AgentEvent {
  return toRawEvent(CLAUDE_CODE_RUNTIME, native, note);
}

function isFileTool(name: string): boolean {
  return CLAUDE_FILE_TOOLS.includes(name);
}

function isCommandTool(name: string): boolean {
  return CLAUDE_COMMAND_TOOLS.includes(name);
}

/** 文件类工具的目标路径：Write/Edit 用 file_path，NotebookEdit 用 notebook_path。 */
function toolInputPath(input: Record<string, unknown>): string | undefined {
  return asString(input["file_path"]) ?? asString(input["notebook_path"]);
}

/**
 * 工具名 + 入参 → 权限信封载荷（设计文档 §7 的 5 类）。
 *
 * 返回 undefined = **该工具无法用信封语义表达**（Task / Cron* / SendMessage /
 * EnterWorktree 这类会逃出工作台执行模型的工具）。此时不编造一个假的权限类别
 * 去骗用户点"同意"，也不把请求悬着：由适配器 fail-closed 自动拒绝并以 raw 留档。
 */
export function toPermissionPayload(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): PermissionRequestPayload | undefined {
  if (isFileTool(toolName)) {
    const path = toolInputPath(input);
    return path === undefined ? undefined : { kind: "write_path", path };
  }
  if (isCommandTool(toolName)) {
    const command = asString(input["command"]);
    return command === undefined ? undefined : { kind: "shell_command", command };
  }
  if (CLAUDE_READ_TOOLS.includes(toolName)) {
    return {
      kind: "read_path",
      path: asString(input["file_path"]) ?? asString(input["path"]) ?? cwd,
    };
  }
  if (CLAUDE_NETWORK_TOOLS.includes(toolName)) {
    const target = asString(input["url"]);
    return { kind: "network", ...(target === undefined ? {} : { target }) };
  }
  return undefined;
}

function mapInit(state: ClaudeCodeMapperState, value: Record<string, unknown>): AgentEvent[] {
  const sessionId = asString(value["session_id"]);
  const model = asString(value["model"]);
  const cwd = asString(value["cwd"]) ?? state.cwd;
  state.sessionId = sessionId;
  state.interruptReceiptSupported = (asArray(value["capabilities"]) ?? []).includes(
    CLAUDE_INTERRUPT_RECEIPT_CAPABILITY,
  );
  return [
    {
      kind: "session_start",
      // 原生会话绑定必须成对登记：resume 严格绑定 cwd（§4，fixture 09）。
      ...(sessionId === undefined
        ? {}
        : { native: { nativeSessionId: sessionId as NativeSessionId, cwd } }),
      ...(model === undefined ? {} : { model }),
    },
  ];
}

function mapToolUse(
  state: ClaudeCodeMapperState,
  value: Record<string, unknown>,
  block: Record<string, unknown>,
): AgentEvent {
  const actionId = asString(block["id"]);
  const name = asString(block["name"]);
  if (actionId === undefined || name === undefined) {
    return raw(value, "tool_use 块缺 id 或 name");
  }
  const input = asObject(block["input"]) ?? {};
  state.pendingTools.set(actionId, { name, input });

  if (isFileTool(name)) {
    const path = toolInputPath(input);
    if (path === undefined) {
      return raw(value, `工具 ${name} 的入参缺 file_path`);
    }
    // started 只是"已发起"的预告：Write 多为新建故记 add，终态由
    // tool_use_result.type 修正（消费方按 actionId 收敛为同一行 UI）。
    return {
      kind: "file_change",
      path,
      changeKind: name === "Write" ? "add" : "update",
      status: "started",
      actionId,
    };
  }
  if (isCommandTool(name)) {
    const command = asString(input["command"]);
    if (command === undefined) {
      return raw(value, "Bash 工具的入参缺 command");
    }
    return { kind: "command", command, status: "started", actionId };
  }
  return raw(value, `工具 ${name} 不属文件/命令两类，仅留档`);
}

/** tool_result 的动作状态：未执行（被拒/被中断）优先于失败。 */
function resolveActionStatus(
  value: Record<string, unknown>,
  block: Record<string, unknown>,
  toolUseId: string,
): AgentActionStatus {
  const meta = asObjectArray(value["tool_result_meta"]).find(
    (entry) => asString(entry["id"]) === toolUseId,
  );
  // non_execution_kind 存在即"根本没执行"（实测值 user-rejected，含 interrupt 场景）。
  if (asString(meta?.["non_execution_kind"]) !== undefined) {
    return "denied";
  }
  return block["is_error"] === true ? "failed" : "completed";
}

function mapToolResult(
  state: ClaudeCodeMapperState,
  value: Record<string, unknown>,
  block: Record<string, unknown>,
): AgentEvent {
  const actionId = asString(block["tool_use_id"]);
  const pending = actionId === undefined ? undefined : state.pendingTools.get(actionId);
  if (actionId === undefined || pending === undefined) {
    return raw(value, "tool_result 找不到配对的 tool_use（resume 前轮残留或流被截断）");
  }
  state.pendingTools.delete(actionId);
  const status = resolveActionStatus(value, block, actionId);
  // 双形态：对象（结构化结果）或字符串（"User rejected tool use"），按 unknown 处理。
  const result = asObject(value["tool_use_result"]);
  const contentText =
    asNonEmptyString(block["content"]) ?? asNonEmptyString(value["tool_use_result"]);

  if (isFileTool(pending.name)) {
    const path = asString(result?.["filePath"]) ?? toolInputPath(pending.input);
    if (path === undefined) {
      return raw(value, `工具 ${pending.name} 的结果与入参均无文件路径`);
    }
    const changeKind: FileChangeKind = asString(result?.["type"]) === "create" ? "add" : "update";
    // Write 新建时 structuredPatch 为空数组 → diff 如实缺席（见 diff.ts）。
    const diff = formatStructuredPatch(path, result?.["structuredPatch"]);
    return {
      kind: "file_change",
      path,
      changeKind,
      status,
      ...(diff === undefined ? {} : { diff }),
      actionId,
    };
  }

  if (isCommandTool(pending.name)) {
    const stdout = asNonEmptyString(result?.["stdout"]);
    const stderr = asNonEmptyString(result?.["stderr"]);
    const output =
      result === undefined
        ? contentText
        : [stdout, stderr].filter((part): part is string => part !== undefined).join("\n");
    return {
      kind: "command",
      command: asString(pending.input["command"]) ?? "",
      status,
      // Bash 无结构化退出码：成功隐含 0，失败/被拒一律缺席，成败由 status 承载
      //（events/types.ts CommandEvent 的约定）。
      ...(block["is_error"] === false ? { exitCode: 0 } : {}),
      ...(output === undefined || output === "" ? {} : { output }),
      actionId,
    };
  }

  return raw(value, `工具 ${pending.name} 的结果不属六类事件，仅留档`);
}

function mapAssistant(state: ClaudeCodeMapperState, value: Record<string, unknown>): AgentEvent[] {
  const message = asObject(value["message"]);
  const messageId = asString(message?.["id"]);
  const blocks = asObjectArray(message?.["content"]);
  if (blocks.length === 0) {
    return [raw(value, "assistant 行无可识别的 content block")];
  }
  const events: AgentEvent[] = [];
  for (const block of blocks) {
    const type = asString(block["type"]);
    if (type === "text" || type === "thinking") {
      // partial 模式下同样的内容已由 stream_event 增量给过，此处不再重复产出。
      if (state.partialMessages) {
        continue;
      }
      const channel: TextChannel = type === "text" ? "answer" : "reasoning";
      events.push({
        kind: "text",
        content: (type === "text" ? asString(block["text"]) : asString(block["thinking"])) ?? "",
        final: true,
        channel,
        ...(messageId === undefined ? {} : { messageId }),
      });
      continue;
    }
    if (type === "tool_use") {
      events.push(mapToolUse(state, value, block));
      continue;
    }
    events.push(raw(value, `assistant 的 ${type ?? "无类型"} content block 未归类`));
  }
  return events;
}

function mapUser(state: ClaudeCodeMapperState, value: Record<string, unknown>): AgentEvent[] {
  const message = asObject(value["message"]);
  const blocks = asObjectArray(message?.["content"]);
  if (blocks.length === 0) {
    return [raw(value, "user 行无可识别的 content block")];
  }
  return blocks.map((block) =>
    asString(block["type"]) === "tool_result"
      ? mapToolResult(state, value, block)
      : // CLI 自造的 user 提示（如 "[Request interrupted by user for tool use]"）
        // 不是 Agent 输出，不能进 text 通道，仅留档。
        raw(value, "user 行的非 tool_result 块（CLI 自造提示）仅留档"),
  );
}

function mapStreamEvent(
  state: ClaudeCodeMapperState,
  value: Record<string, unknown>,
): AgentEvent[] {
  const event = asObject(value["event"]);
  const type = asString(event?.["type"]);
  if (event === undefined || type === undefined) {
    return [raw(value, "stream_event 缺 event.type")];
  }
  const messageId = state.streamMessageId;
  switch (type) {
    case "message_start": {
      state.streamMessageId = asString(asObject(event["message"])?.["id"]);
      state.streamBlockChannels.clear();
      return [];
    }
    case "content_block_start": {
      const index = asNumber(event["index"]);
      const blockType = asString(asObject(event["content_block"])?.["type"]);
      if (index !== undefined && (blockType === "text" || blockType === "thinking")) {
        state.streamBlockChannels.set(index, blockType === "text" ? "answer" : "reasoning");
      }
      return [];
    }
    case "content_block_delta": {
      const delta = asObject(event["delta"]);
      const deltaType = asString(delta?.["type"]);
      const text =
        deltaType === "text_delta"
          ? asString(delta?.["text"])
          : deltaType === "thinking_delta"
            ? asString(delta?.["thinking"])
            : undefined;
      if (text === undefined) {
        // input_json_delta（工具入参增量）等：整块 assistant 行会给出完整入参，
        // 增量本身无用，留档即可。
        return [raw(value, `stream_event 的 ${deltaType ?? "无类型"} 增量未归类`)];
      }
      const index = asNumber(event["index"]);
      return [
        {
          kind: "text",
          content: text,
          final: false,
          channel:
            (index === undefined ? undefined : state.streamBlockChannels.get(index)) ??
            (deltaType === "text_delta" ? "answer" : "reasoning"),
          ...(messageId === undefined ? {} : { messageId }),
        },
      ];
    }
    case "content_block_stop": {
      const index = asNumber(event["index"]);
      const channel = index === undefined ? undefined : state.streamBlockChannels.get(index);
      if (index === undefined || channel === undefined) {
        return [raw(value, "stream_event 的 content_block_stop 无对应的块通道")];
      }
      state.streamBlockChannels.delete(index);
      // 空 content 的收尾信号（events/types.ts TextEvent 约定），不重复正文。
      return [
        {
          kind: "text",
          content: "",
          final: true,
          channel,
          ...(messageId === undefined ? {} : { messageId }),
        },
      ];
    }
    default:
      return [raw(value, `stream_event 的 ${type} 未归类`)];
  }
}

function toTokenUsage(value: Record<string, unknown>): TokenUsage {
  const usage = asObject(value["usage"]);
  const inputTokens = asNumber(usage?.["input_tokens"]);
  const outputTokens = asNumber(usage?.["output_tokens"]);
  const cachedInputTokens = asNumber(usage?.["cache_read_input_tokens"]);
  const costUsd = asNumber(value["total_cost_usd"]);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/**
 * result → 结束原因。
 *
 * 硬规则（§9.3 坑 2）：`permission_denials` 非空一律**不得**记 completed——
 * 默认权限模式下被拒的 Run 仍返回 subtype success / is_error false，
 * 只看 subtype 会把"什么都没做"记成成功。信封外的工具被拒 = 任务没做完 = failed，
 * 由 core 层据 permission_request 事件与本 message 决定是否转 blocked 复盘。
 */
function resolveEndReason(
  subtype: string | undefined,
  terminalReason: string | undefined,
  denialCount: number,
): RunEndReason {
  if (terminalReason === "aborted_tools") {
    return "cancelled";
  }
  if (denialCount > 0 || subtype !== "success") {
    return "failed";
  }
  return "completed";
}

function describeResult(value: Record<string, unknown>, denialCount: number): string | undefined {
  const parts: string[] = [];
  for (const error of asArray(value["errors"]) ?? []) {
    const text = asNonEmptyString(error);
    if (text !== undefined) {
      parts.push(text);
    }
  }
  if (denialCount > 0) {
    const tools = asObjectArray(value["permission_denials"])
      .map((denial) => asString(denial["tool_name"]) ?? "未知工具")
      .join("、");
    parts.push(`权限被拒 ${denialCount} 项（${tools}）：任务未完成，不得记为成功`);
  }
  return parts.length === 0 ? undefined : parts.join("；");
}

function mapResult(value: Record<string, unknown>): EndEvent[] {
  const denialCount = asObjectArray(value["permission_denials"]).length;
  const reason = resolveEndReason(
    asString(value["subtype"]),
    asString(value["terminal_reason"]),
    denialCount,
  );
  const usage = toTokenUsage(value);
  const message = describeResult(value, denialCount);
  return [
    {
      kind: "end",
      reason,
      ...(Object.keys(usage).length === 0 ? {} : { usage }),
      ...(message === undefined ? {} : { message }),
    },
  ];
}

/**
 * 一条原生记录 → 零或多条统一事件。
 *
 * 零条的两种情形：partial 模式下的 message_start / content_block_start（纯状态
 * 记账），以及 partial 模式下被让路的 assistant 文本块。
 */
export function mapClaudeCodeRecord(
  state: ClaudeCodeMapperState,
  record: JsonlRecord,
): readonly AgentEvent[] {
  if (!record.ok) {
    // 非 JSON 行是实测形态（跨 cwd resume 的首行报错，fixture 09），不是异常。
    return [raw(record.raw, record.reason)];
  }
  const value = record.value;
  switch (asString(value["type"])) {
    case "system":
      return asString(value["subtype"]) === "init"
        ? mapInit(state, value)
        : // thinking_tokens / status / task_started 等：版本漂移的主要形态，跳过即留档。
          [raw(value, `system 的 ${asString(value["subtype"]) ?? "无"} subtype 未归类`)];
    case "assistant":
      return mapAssistant(state, value);
    case "user":
      return mapUser(state, value);
    case "stream_event":
      return state.partialMessages
        ? mapStreamEvent(state, value)
        : [raw(value, "未开启 --include-partial-messages，stream_event 仅留档")];
    case "control_request": {
      const request = parseCanUseToolRequest(value);
      if (request === undefined) {
        return [raw(value, "非 can_use_tool 的控制请求未归类")];
      }
      const payload = toPermissionPayload(request.toolName, request.input, state.cwd);
      if (payload === undefined) {
        return [raw(value, `工具 ${request.toolName} 无法表达为权限信封载荷，适配器将自动拒绝`)];
      }
      return [
        {
          kind: "permission_request",
          nativeRequestId: request.requestId,
          payload,
          ...(request.description === undefined ? {} : { reason: request.description }),
          toolName: request.toolName,
        },
      ];
    }
    case "control_response":
      // 回执由适配器的协议层消费（interrupt 确认），事件流只留档。
      return [raw(value, "控制回执由适配器协议层处理，仅留档")];
    case "result":
      return mapResult(value);
    default:
      return [raw(value, "未知的顶层 type")];
  }
}
