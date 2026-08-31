/**
 * Grok Build NDJSON 事件 → 统一 AgentEvent 映射器（T7.3）。
 *
 * 纯映射、零 I/O：输入是 W2.1b 的 JsonlRecord，输出是 AgentEvent 数组，
 * 故可直接用 fixtures/grok-build/*.jsonl 回放（tests/grok-build.test.ts）。
 *
 * 词汇表来源：docs/adapters/grok-build.md §2（真机录制 + CLI 随装文档核对）。
 * 未归类的一律走 raw——官方自己说事件列表「非穷尽」，静默丢弃就是丢证据。
 *
 * 四条硬约定：
 *
 * 1. **`stopReason: "cancelled"` 不是成功**（§7.3 坑 1，头号坑）。默认权限模式下
 *    headless 无人可问审批，每个工具直接以「User cancelled」落地、文件一个没写，
 *    而 `end.stopReason` 是 `cancelled`、**进程退出码是 0**。把它当 completed，
 *    一次什么都没干的 Run 就会被记成成功，还能满足任务 done 的证据门槛。
 * 2. **「失败」要分辨出「被拒」**。grok 把权限拒绝也报成 `status: "failed"`，
 *    真相在文本里（「Denied by permission policy」/「User cancelled the execution」）。
 *    统一模型里 failed 与 denied 语义不同——前者执行过、要入证据，后者压根没执行
 *    （guard/evidence.ts 的分野）。故这里按文本把它归到 denied。
 * 3. **end 恰好一条且在最后**（adapter.ts 约定）。终止事实到达时只登记，
 *    由 finalize() 统一收尾，这样既能带上进程退出码，也不会出现 end 之后还有事件。
 * 4. **sessionId 只有 end 才给**（§7.3 坑 5）。故 session_start 是在 finalize 时
 *    补发的，位置在 end 之前；轮次中途崩掉就没有会话 ID，这是实况不是缺陷。
 */

import type { ModelId, NativeSessionId, RunEndReason } from "@ff-pane/shared";
import type {
  AgentActionStatus,
  AgentEvent,
  EndEvent,
  FileChangeKind,
  JsonlRecord,
  SessionStartEvent,
  TokenUsage,
} from "../events/index.js";
import { isJsonObject, nativeEventType, toRawEvent } from "../events/index.js";
import { GROK_BUILD_RUNTIME } from "./command.js";
import { firstDiffPath, renderGrokDiffFromContent } from "./diff.js";

/**
 * 「这次工具调用没有真的执行」的文本标记（真机录制原文，见 fixtures 的
 * headless-noapprove / deny-rule 两份）。命中即把 failed 改判为 denied。
 * 用文本匹配是无奈但唯一的路：grok 在结构上不区分「失败」与「被拒」。
 */
const DENIAL_MARKERS = [
  "Denied by permission policy",
  "User cancelled the execution",
  "was not executed",
] as const;

/** grok 工具状态 → 统一动作状态（`null` = 中间进度，见 §2.1）。 */
const TOOL_STATUS: Readonly<Record<string, AgentActionStatus>> = {
  pending: "started",
  in_progress: "started",
  completed: "completed",
  failed: "failed",
};

/** ACP 工具类目里属于「改文件」的两种（§2.1）。 */
const FILE_TOOL_KINDS = new Set(["write", "edit", "delete"]);

/** 兜底识别：内部工具 ID（`--tools` 用的也是这套名字）。 */
const FILE_TOOL_NAMES = new Set(["write", "search_replace", "edit_file", "create_file"]);

/** 摘要里命令原文的截断长度。 */
const COMMAND_EXCERPT_LENGTH = 60;

/** 阻断证据摘要最多列出的条目数。 */
const BLOCKAGE_EXCERPT_COUNT = 3;

/** 流结束时的进程终局（由适配器从 AgentProcessExit 翻译而来）。 */
export interface GrokStreamOutcome {
  /** 是否为适配器主动取消（cancel() 或 timeoutMs 到期树杀）。 */
  readonly cancelled: boolean;
  /** 进程根本没起来。 */
  readonly spawnFailed: boolean;
  /** 进程退出码；未知为 null。 */
  readonly exitCode: number | null;
  /** 进程级错误原文 / stderr 尾巴，无则 null。 */
  readonly error: string | null;
}

/** 已登记但尚未吐出的终止事实。 */
interface PendingTerminal {
  readonly reason: RunEndReason;
  readonly usage?: TokenUsage;
  readonly message?: string;
  readonly sessionId?: string;
}

/** 一次工具调用的登记信息（update 事件只带 toolCallId，工具身份要靠它回溯）。 */
interface ToolState {
  readonly toolName: string;
  readonly kind: string;
  /** 文件类工具的目标路径（取自 rawInput）。 */
  readonly path?: string;
  /** 命令类工具的命令原文（取自 rawInput）。 */
  readonly command?: string;
}

/** Grok 事件映射器。有状态（登记工具调用与终止事实），一个实例只服务一轮。 */
export interface GrokEventMapper {
  /** 映射一条原生记录，返回 0..n 条统一事件。 */
  map(record: JsonlRecord): readonly AgentEvent[];
  /** 流结束收尾：补 session_start（若拿到了会话 ID）+ 恰好一条 end。 */
  finalize(outcome: GrokStreamOutcome): readonly AgentEvent[];
  /** 是否已收到 end / error（诊断用）。 */
  sawTerminalEvent(): boolean;
  /** 本轮攒到的阻断证据（诊断用，事件流外）。 */
  blockages(): readonly string[];
}

/** createGrokEventMapper 的可选项。 */
export interface GrokEventMapperOptions {
  /** 本轮工作目录，与 sessionId 成对构成 NativeSessionBinding。 */
  readonly cwd: string;
  /** 本轮请求的模型；grok 的 streaming-json 流不报模型，只能由调用方给。 */
  readonly model?: ModelId | undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function excerpt(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= COMMAND_EXCERPT_LENGTH
    ? single
    : `${single.slice(0, COMMAND_EXCERPT_LENGTH)}…`;
}

/** usage 映射（§2 的 end 载荷；逐条 usage 行不映射，理由见 §7.1）。 */
function mapUsage(value: unknown): TokenUsage | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const inputTokens = asNumber(value["input_tokens"]);
  const outputTokens = asNumber(value["output_tokens"]);
  const cachedInputTokens = asNumber(value["cache_read_input_tokens"]);
  const reasoningTokens = asNumber(value["reasoning_tokens"]);
  const totalTokens = asNumber(value["total_tokens"]);
  const usage: TokenUsage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/** 汇总 content[] 里的文本片段（拒绝文本与命令输出都藏在这里）。 */
function collectContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const entry of content) {
    if (!isJsonObject(entry) || entry["type"] !== "content") {
      continue;
    }
    const inner = entry["content"];
    const text = isJsonObject(inner) ? asString(inner["text"]) : undefined;
    if (text !== undefined && text !== "") {
      parts.push(text);
    }
  }
  return parts.join("");
}

/** 工具是不是「改文件」类（kind 优先，工具名兜底，见 §2.1 第 3 点）。 */
function isFileTool(state: ToolState): boolean {
  return FILE_TOOL_KINDS.has(state.kind) || FILE_TOOL_NAMES.has(state.toolName);
}

/** 新旧文本 → 变更类型。只在拿到 diff 载荷时才判定，判不出就不发 file_change。 */
function changeKindOf(content: unknown): FileChangeKind | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const entry of content) {
    if (!isJsonObject(entry) || entry["type"] !== "diff") {
      continue;
    }
    const oldText = asString(entry["oldText"]) ?? "";
    const newText = asString(entry["newText"]) ?? "";
    if (oldText === "" && newText !== "") {
      return "add";
    }
    return newText === "" ? "delete" : "update";
  }
  return undefined;
}

/** 创建映射器。 */
export function createGrokEventMapper(options: GrokEventMapperOptions): GrokEventMapper {
  const { cwd, model } = options;
  const tools = new Map<string, ToolState>();
  const blocked: string[] = [];
  let pending: PendingTerminal | null = null;
  let sawAnswerText = false;
  let sawReasoningText = false;

  function raw(native: unknown, note: string): AgentEvent {
    return toRawEvent(GROK_BUILD_RUNTIME, native, note);
  }

  /**
   * 状态判定：文本里带拒绝标记的 failed 一律改判 denied（约定 2）。
   * `null` 是中间进度，按 started 处理；未知字符串按 started 兜底并留 raw 诊断。
   */
  function statusOf(
    rawStatus: unknown,
    text: string,
  ): { readonly status: AgentActionStatus; readonly unrecognized?: string } {
    if (rawStatus === null || rawStatus === undefined) {
      return { status: "started" };
    }
    const known = typeof rawStatus === "string" ? TOOL_STATUS[rawStatus] : undefined;
    if (known === undefined) {
      return {
        status: "started",
        unrecognized: `tool status 未识别：${JSON.stringify(rawStatus)}`,
      };
    }
    if (known === "failed" && DENIAL_MARKERS.some((marker) => text.includes(marker))) {
      return { status: "denied" };
    }
    return { status: known };
  }

  /** text / thought → TextEvent（真增量，final 恒为 false，收尾在 finalize）。 */
  function mapText(native: Record<string, unknown>, channel: "answer" | "reasoning"): AgentEvent[] {
    const content = asString(native["data"]);
    if (content === undefined) {
      return [raw(native, `${channel} 事件缺 data 字段`)];
    }
    if (channel === "answer") {
      sawAnswerText = true;
    } else {
      sawReasoningText = true;
    }
    return [{ kind: "text", content, final: false, channel }];
  }

  /** tool_call：登记工具身份，命令类当场发 started，文件类等带 diff 的 update。 */
  function mapToolCall(native: Record<string, unknown>): AgentEvent[] {
    const toolCallId = asString(native["toolCallId"]);
    if (toolCallId === undefined) {
      return [raw(native, "tool_call 缺 toolCallId")];
    }
    const rawInput = isJsonObject(native["rawInput"]) ? native["rawInput"] : {};
    const state: ToolState = {
      toolName: asString(native["toolName"]) ?? "",
      kind: asString(native["kind"]) ?? "",
      ...(asString(rawInput["file_path"]) === undefined
        ? {}
        : { path: asString(rawInput["file_path"]) as string }),
      ...(asString(rawInput["command"]) === undefined
        ? {}
        : { command: asString(rawInput["command"]) as string }),
    };
    tools.set(toolCallId, state);

    if (state.kind === "execute" && state.command !== undefined) {
      return [{ kind: "command", command: state.command, status: "started", actionId: toolCallId }];
    }
    if (isFileTool(state)) {
      // 刻意不在这里发 file_change：此刻只知道路径，不知道是新建还是改写，
      // 而 changeKind 是必填字段——猜一个就是造假。紧随其后的 update 带着
      // oldText/newText，那时才判得出（§2.1）。
      return [raw(native, "tool_call（文件类）：登记路径，等带 diff 的 update 再发 file_change")];
    }
    return [raw(native, "tool_call：该工具类目无对应统一事件，只记原始日志")];
  }

  /** tool_call_update：按登记的工具身份分派到 file_change / command。 */
  function mapToolCallUpdate(native: Record<string, unknown>): AgentEvent[] {
    const toolCallId = asString(native["toolCallId"]);
    if (toolCallId === undefined) {
      return [raw(native, "tool_call_update 缺 toolCallId")];
    }
    const state = tools.get(toolCallId);
    if (state === undefined) {
      return [raw(native, `tool_call_update 的 toolCallId「${toolCallId}」没有对应的 tool_call`)];
    }
    const content = native["content"];
    const text = collectContentText(content);
    const { status, unrecognized } = statusOf(native["status"], text);
    const extra = unrecognized === undefined ? [] : [raw(native, unrecognized)];

    if (state.kind === "execute") {
      const rawOutput = isJsonObject(native["rawOutput"]) ? native["rawOutput"] : undefined;
      const command = (rawOutput ? asString(rawOutput["command"]) : undefined) ?? state.command;
      if (command === undefined) {
        return [
          raw(native, "命令类 tool_call_update 无命令原文（tool_call 与 rawOutput 都没有）"),
          ...extra,
        ];
      }
      const exitCode = rawOutput ? asNumber(rawOutput["exit_code"]) : undefined;
      const cwdOfCommand = rawOutput ? asString(rawOutput["current_dir"]) : undefined;
      // 输出取 content 里的终端原文；没有就退回 rawOutput.output_for_prompt
      // （后者是给模型看的渲染，完成态会带一行 "exit: N" 前缀，非终端原样）。
      const output =
        text !== "" ? text : rawOutput ? (asString(rawOutput["output_for_prompt"]) ?? "") : "";
      return [
        {
          kind: "command",
          command,
          status,
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(output === "" ? {} : { output }),
          ...(cwdOfCommand === undefined ? {} : { cwd: cwdOfCommand }),
          actionId: toolCallId,
        },
        ...extra,
      ];
    }

    if (isFileTool(state)) {
      const path = firstDiffPath(content) ?? state.path;
      if (path === undefined) {
        return [
          raw(native, "文件类 tool_call_update 无路径（rawInput 与 content 都没有）"),
          ...extra,
        ];
      }
      const changeKind = changeKindOf(content);
      if (changeKind === undefined) {
        // 被拒/失败的更新常常不带 diff 载荷（实测 deny-rule fixture 即如此）。
        // 这类事实必须报出去——否则「想写但被拒」在事件流里完全看不见——
        // 但新旧文本都没有，变更类型只能按「试图写入」记为 update。
        if (status === "denied" || status === "failed") {
          return [
            { kind: "file_change", path, changeKind: "update", status, actionId: toolCallId },
            raw(native, "文件类 update 无 diff 载荷（被拒/失败），changeKind 按 update 记"),
            ...extra,
          ];
        }
        return [
          raw(native, "文件类 tool_call_update 无 diff 载荷，未映射为 file_change"),
          ...extra,
        ];
      }
      const diff = renderGrokDiffFromContent(content);
      return [
        {
          kind: "file_change",
          path,
          changeKind,
          status,
          ...(diff === undefined ? {} : { diff }),
          actionId: toolCallId,
        },
        ...extra,
      ];
    }

    return [raw(native, "tool_call_update：该工具类目无对应统一事件，只记原始日志"), ...extra];
  }

  /**
   * end：登记终止事实。
   *
   * stopReason 的映射取舍——**只有 `end_turn` 算成功**：
   * - `cancelled`：审批拒绝或用户中断，本轮没干成事（约定 1）；
   * - 其余（`max_tokens` / `max_turn_requests` / `refusal` / 未来新增值）：
   *   活儿都没干完，报 failed 并把原文写进 message。宁可让用户看到一个说得清
   *   原因的失败，也不能把半截活儿记成成功——后者会满足任务 done 的证据门槛。
   */
  function registerEnd(native: Record<string, unknown>): void {
    const usage = mapUsage(native["usage"]);
    const sessionId = asString(native["sessionId"]);
    const stopReason = asString(native["stopReason"]) ?? "";
    const base = {
      ...(usage === undefined ? {} : { usage }),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    if (stopReason === "cancelled") {
      pending = {
        reason: "cancelled",
        ...base,
        message:
          "grok 以 stopReason=cancelled 收尾：本轮有工具调用未获批准而未执行" +
          "（headless 下无审批通道，须以 --always-approve 运行，见 grok-build.md §7.3 坑 1）",
      };
      return;
    }
    if (stopReason !== "end_turn") {
      pending = {
        reason: "failed",
        ...base,
        message: `grok 以 stopReason=${stopReason === "" ? "(缺席)" : stopReason} 收尾，本轮未正常完成`,
      };
      return;
    }
    if (blocked.length === 0) {
      pending = { reason: "completed", ...base };
      return;
    }
    const listed = blocked.slice(0, BLOCKAGE_EXCERPT_COUNT).join("；");
    const more = blocked.length > BLOCKAGE_EXCERPT_COUNT ? ` 等 ${blocked.length} 项` : "";
    pending = {
      reason: "failed",
      ...base,
      message: `grok 以 stopReason=end_turn 收尾，但本轮有动作被拒或写入失败：${listed}${more}`,
    };
  }

  /** error：流级错误，实测**不会**再有 end（§2.3），故直接登记为终止事实。 */
  function registerError(native: Record<string, unknown>): void {
    const message = asString(native["message"]);
    pending = {
      reason: "failed",
      message: message ?? "grok 报 error 事件但未给出错误文本",
    };
  }

  /** 阻断证据：被拒的动作与写入失败（与 codex 适配器同一口径）。 */
  function blockageOf(event: AgentEvent): string | undefined {
    if (event.kind === "file_change") {
      if (event.status === "denied") {
        return `file_change ${event.path}：被拒绝`;
      }
      return event.status === "failed" ? `file_change ${event.path}：写入失败` : undefined;
    }
    if (event.kind === "command" && event.status === "denied") {
      return `command 被拒绝：${excerpt(event.command)}`;
    }
    return undefined;
  }

  return {
    map(record: JsonlRecord): readonly AgentEvent[] {
      if (!record.ok) {
        return [raw(record.raw, record.reason)];
      }
      const native = record.value;
      let events: readonly AgentEvent[];
      switch (nativeEventType(native)) {
        case "text":
          events = mapText(native, "answer");
          break;
        case "thought":
          events = mapText(native, "reasoning");
          break;
        case "tool_call":
          events = mapToolCall(native);
          break;
        case "tool_call_update":
          events = mapToolCallUpdate(native);
          break;
        case "end":
          registerEnd(native);
          return [];
        case "error":
          registerError(native);
          return [];
        case "usage":
          // 逐次模型响应的 token 数。**不映射进 end 的 usage**：一轮里有多条，
          // 累加口径与 end 的汇总不一致（end 已含全部），两者相加会重复计。
          events = [raw(native, "usage 行：逐次响应的 token 统计，汇总以 end 为准")];
          break;
        case "available_commands":
          // 每次模型响应前都重发一遍，内容完全相同（§2）。只记原始日志。
          events = [raw(native, "available_commands：工具/命令清单，只记原始日志")];
          break;
        default:
          events = [raw(native, "未归类的顶层事件类型（官方明言事件列表非穷尽）")];
      }
      for (const event of events) {
        const blockage = blockageOf(event);
        if (blockage !== undefined) {
          blocked.push(blockage);
        }
      }
      return events;
    },

    finalize(outcome: GrokStreamOutcome): readonly AgentEvent[] {
      const events: AgentEvent[] = [];
      // 文本收尾信号：grok 的 text 是真增量，流里没有「这条消息说完了」的事件，
      // 故在收尾时各补一条空 content 的 final（events/types.ts 的追加语义）。
      if (sawAnswerText) {
        events.push({ kind: "text", content: "", final: true, channel: "answer" });
      }
      if (sawReasoningText) {
        events.push({ kind: "text", content: "", final: true, channel: "reasoning" });
      }
      const sessionId = pending?.sessionId;
      if (sessionId !== undefined && sessionId !== "") {
        // session_start 补发在 end 之前（约定 4）：ID 与 cwd 成对登记，
        // 因为 grok 的会话按 cwd 分桶，换目录恢复会找不到或走错地方（§3）。
        const start: SessionStartEvent = {
          kind: "session_start",
          native: { nativeSessionId: sessionId as NativeSessionId, cwd },
          ...(model === undefined ? {} : { model }),
        };
        events.push(start);
      }
      const exitCode = outcome.exitCode === null ? {} : { exitCode: outcome.exitCode };
      if (pending !== null) {
        const end: EndEvent = {
          kind: "end",
          reason: pending.reason,
          ...(pending.usage === undefined ? {} : { usage: pending.usage }),
          ...(pending.message === undefined ? {} : { message: pending.message }),
          ...exitCode,
        };
        events.push(end);
        return events;
      }
      // 兜底（§2.3 实测：强杀后 stdout 只剩 available_commands，无 end 无 error）。
      const reason: RunEndReason = outcome.cancelled
        ? "cancelled"
        : outcome.spawnFailed
          ? "failed"
          : "crashed";
      const note = outcome.spawnFailed
        ? "grok 进程未能启动"
        : `grok 进程结束但未收到 end / error 事件（事件流被截断，判定为 ${reason}）`;
      events.push({
        kind: "end",
        reason,
        message: outcome.error === null ? note : `${note}：${outcome.error}`,
        ...exitCode,
      });
      return events;
    },

    sawTerminalEvent(): boolean {
      return pending !== null;
    },

    blockages(): readonly string[] {
      return [...blocked];
    },
  };
}
