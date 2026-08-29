/**
 * Codex JSONL 事件 → 统一 AgentEvent 映射器（W2.3）。
 *
 * 纯映射、零 I/O：输入是 W2.1b 的 JsonlRecord，输出是 AgentEvent 数组，
 * 故可直接用 fixtures/codex/*.jsonl 回放测试（tests/codex.test.ts）。
 * diff 自补是 I/O，留在适配器层给 file_change 事件补字段（见 git-diff.ts）。
 *
 * 词汇表来源：docs/adapters/codex.md §2（8 种顶层事件 × 9 种 item），
 * 与官方 `codex-rs/exec/src/exec_events.rs` 核对过。**未归类的一律走 raw**
 * ——官方明言 `--json` schema 会漂移（§7.2），静默丢弃就是丢证据。
 *
 * 两条硬约定：
 * 1. **turn.completed ≠ 任务成功**（§7.3 坑 1，头号坑）。Windows 沙箱失败时
 *    file_change status=failed、command exit_code=-1，turn 却照样 completed、
 *    退出码 0。故本映射器在收到 turn.completed 时检查"环境阻断证据"
 *    （见 blockageOf），有证据就把 end 收成 failed 并写明原因，绝不报成功。
 * 2. **end 恰好一条且在最后**（adapter.ts AdapterTurn 约定）。终止事件到达时
 *    只登记，不立即产出；end 统一由 finalize() 在流结束后吐出，这样既能带上
 *    进程退出码，也不会出现"end 之后还有事件"。
 */

import type { ModelId, NativeSessionId, RunEndReason } from "@ff-pane/shared";
import type {
  AgentActionStatus,
  AgentEvent,
  EndEvent,
  JsonlRecord,
  TextChannel,
  TokenUsage,
} from "../events/index.js";
import { isJsonObject, nativeEventType, toRawEvent } from "../events/index.js";
import { CODEX_RUNTIME } from "./command.js";

/**
 * 沙箱层拒绝执行命令时 Codex 给的退出码（codex.md §2.4：错误文本塞进
 * aggregated_output，退出码 -1）。这不是"命令跑完失败"，而是根本没跑成，
 * 故它是环境阻断证据之一。
 */
export const CODEX_SANDBOX_ERROR_EXIT_CODE = -1;

/** item.status → 统一动作状态。declined 是 Codex 唯一的"被拒"信号（§2.4）。 */
const ITEM_STATUS: Readonly<Record<string, AgentActionStatus>> = {
  in_progress: "started",
  completed: "completed",
  failed: "failed",
  declined: "denied",
};

/** item 事件的三个相位（顶层 item.started / item.updated / item.completed）。 */
type ItemPhase = "started" | "updated" | "completed";

/** 阻断证据摘要里命令原文的截断长度（命令是完整 powershell 调用串，很长）。 */
const COMMAND_EXCERPT_LENGTH = 60;

/** 阻断证据摘要最多列出的条目数。 */
const BLOCKAGE_EXCERPT_COUNT = 3;

/** 流结束时的进程终局（由适配器从 AgentProcessExit 翻译而来）。 */
export interface CodexStreamOutcome {
  /** 是否为适配器主动取消（cancel() 或 timeoutMs 到期树杀）。 */
  readonly cancelled: boolean;
  /** 进程根本没起来（PATH 里没有 codex 等）。 */
  readonly spawnFailed: boolean;
  /** 进程退出码；未知为 null。 */
  readonly exitCode: number | null;
  /** 进程级错误原文 / stderr 尾巴，无则 null。 */
  readonly error: string | null;
}

/** 已登记但尚未吐出的终止事实（见文件头约定 2）。 */
interface PendingTerminal {
  readonly reason: RunEndReason;
  readonly usage?: TokenUsage;
  readonly message?: string;
}

/** Codex 事件映射器。有状态（要攒终止事实与阻断证据），一个实例只服务一轮。 */
export interface CodexEventMapper {
  /** 映射一条原生记录，返回 0..n 条统一事件（终止事件返回空数组）。 */
  map(record: JsonlRecord): readonly AgentEvent[];
  /** 流结束收尾：吐出恰好一条 end（已登记则用之，否则按进程终局兜底）。 */
  finalize(outcome: CodexStreamOutcome): readonly AgentEvent[];
  /** 是否已收到 turn.completed / turn.failed（诊断用）。 */
  sawTerminalEvent(): boolean;
  /** 本轮攒到的环境阻断证据（诊断用，事件流外）。 */
  blockages(): readonly string[];
}

/** createCodexEventMapper 的可选项。 */
export interface CodexEventMapperOptions {
  /** 本轮工作目录，与 thread_id 成对构成 NativeSessionBinding。 */
  readonly cwd: string;
  /** 本轮请求的模型；Codex 事件流本身不报模型，故只能由调用方给。 */
  readonly model?: ModelId | undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function excerpt(text: string): string {
  return text.length <= COMMAND_EXCERPT_LENGTH ? text : `${text.slice(0, COMMAND_EXCERPT_LENGTH)}…`;
}

/**
 * usage 映射（codex.md §2 的 turn.completed 载荷）。
 * `cache_write_input_tokens` 在 TokenUsage 里没有落点（W2.1b 的字段集以四家
 * 交集为准），Codex 独有此项，故不映射——统计口径以其余四项为准。
 */
function mapUsage(value: unknown): TokenUsage | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const inputTokens = asNumber(value["input_tokens"]);
  const outputTokens = asNumber(value["output_tokens"]);
  const cachedInputTokens = asNumber(value["cached_input_tokens"]);
  const reasoningTokens = asNumber(value["reasoning_output_tokens"]);
  const usage: TokenUsage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/**
 * item.status → 动作状态。
 * 未知/缺席的 status 按相位兜底（started → started，其余 → completed），
 * 同时由调用方补一条 raw 诊断，既不丢事件也不掩盖词汇漂移。
 */
function itemStatus(
  phase: ItemPhase,
  raw: unknown,
): { readonly status: AgentActionStatus; readonly unrecognized?: string } {
  const known = typeof raw === "string" ? ITEM_STATUS[raw] : undefined;
  if (known !== undefined) {
    return { status: known };
  }
  const status: AgentActionStatus = phase === "started" ? "started" : "completed";
  return raw === undefined
    ? { status }
    : { status, unrecognized: `item.status 未识别：${JSON.stringify(raw)}` };
}

/**
 * "环境阻断"证据判定 —— turn.completed 是否可信为成功的唯一依据。
 *
 * 收录（codex.md §7.3 坑 1 与 fixture exec-sandbox-error-win.jsonl 实证）：
 * - 任何 denied（item status=declined）：被沙箱/审批拒绝，压根没执行；
 * - file_change failed：写文件失败，任务产物没落地；
 * - command failed 且 exit_code = -1：沙箱层报错，命令没跑起来。
 *
 * 故意不收：**带真实退出码的命令失败**。fixture exec-basic.jsonl 里模型先跑
 * 错一条 PowerShell（exit 1）再改对，那是正常的试错过程，把它算作阻断会把
 * 成功的 Run 误判为失败。
 */
function blockageOf(event: AgentEvent): string | undefined {
  if (event.kind === "file_change") {
    if (event.status === "denied") {
      return `file_change ${event.path}：被拒绝`;
    }
    return event.status === "failed" ? `file_change ${event.path}：写入失败` : undefined;
  }
  if (event.kind === "command") {
    if (event.status === "denied") {
      return `command 被拒绝：${excerpt(event.command)}`;
    }
    return event.status === "failed" && event.exitCode === CODEX_SANDBOX_ERROR_EXIT_CODE
      ? `command 沙箱层报错（exit_code=-1）：${excerpt(event.command)}`
      : undefined;
  }
  return undefined;
}

/** 创建映射器。 */
export function createCodexEventMapper(options: CodexEventMapperOptions): CodexEventMapper {
  const { cwd, model } = options;
  let pending: PendingTerminal | null = null;
  const blocked: string[] = [];

  function raw(native: unknown, note: string): AgentEvent {
    return toRawEvent(CODEX_RUNTIME, native, note);
  }

  /** agent_message / reasoning → text。整条到达，故 final 恒为 true（§2.1）。 */
  function mapText(
    phase: ItemPhase,
    item: Record<string, unknown>,
    channel: TextChannel,
  ): AgentEvent[] {
    if (phase !== "completed") {
      // 0.147.0 实测这两类只出现在 item.completed；真出现在别的相位就是词汇
      // 漂移，留档但不当正式文本（半条文本混进 Run 报告即事实污染）。
      return [raw(item, `${channel} item 出现在 item.${phase}，非 item.completed，未映射为 text`)];
    }
    const content = asString(item["text"]);
    if (content === undefined) {
      return [raw(item, "文本 item 缺 text 字段")];
    }
    const messageId = asString(item["id"]);
    return [
      {
        kind: "text",
        content,
        final: true,
        channel,
        ...(messageId === undefined ? {} : { messageId }),
      },
    ];
  }

  /** file_change → 每个 changes[] 条目一条 file_change 事件（§2.3）。 */
  function mapFileChange(phase: ItemPhase, item: Record<string, unknown>): AgentEvent[] {
    const changes = item["changes"];
    if (!Array.isArray(changes) || changes.length === 0) {
      return [raw(item, "file_change item 的 changes 缺席或为空")];
    }
    const { status, unrecognized } = itemStatus(phase, item["status"]);
    const actionId = asString(item["id"]);
    const events: AgentEvent[] = [];
    for (const change of changes) {
      const path = isJsonObject(change) ? asString(change["path"]) : undefined;
      const kind = isJsonObject(change) ? change["kind"] : undefined;
      if (path === undefined || (kind !== "add" && kind !== "update" && kind !== "delete")) {
        events.push(raw(change, "file_change 的 changes[] 条目缺 path 或 kind 非法"));
        continue;
      }
      events.push({
        kind: "file_change",
        path,
        changeKind: kind,
        status,
        ...(actionId === undefined ? {} : { actionId }),
      });
    }
    if (unrecognized !== undefined) {
      events.push(raw(item, unrecognized));
    }
    return events;
  }

  /** command_execution → command（§2.4）。 */
  function mapCommand(phase: ItemPhase, item: Record<string, unknown>): AgentEvent[] {
    const command = asString(item["command"]);
    if (command === undefined) {
      return [raw(item, "command_execution item 缺 command 字段")];
    }
    const { status, unrecognized } = itemStatus(phase, item["status"]);
    // in_progress 时 exit_code 为 null、aggregated_output 为空串：缺席即无此
    // 信息，不填 0 也不填空串（events/types.ts 的字段缺席语义）。
    const exitCode = asNumber(item["exit_code"]);
    const output = asString(item["aggregated_output"]);
    const actionId = asString(item["id"]);
    const events: AgentEvent[] = [
      {
        kind: "command",
        command,
        status,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(output === undefined || output === "" ? {} : { output }),
        ...(actionId === undefined ? {} : { actionId }),
      },
    ];
    if (unrecognized !== undefined) {
      events.push(raw(item, unrecognized));
    }
    return events;
  }

  /** item.* 的 9 型分派（§2.1~§2.5）。 */
  function mapItem(phase: ItemPhase, native: Record<string, unknown>): AgentEvent[] {
    const item = native["item"];
    if (!isJsonObject(item)) {
      return [raw(native, `item.${phase} 缺 item 对象`)];
    }
    switch (item["type"]) {
      case "agent_message":
        return mapText(phase, item, "answer");
      case "reasoning":
        return mapText(phase, item, "reasoning");
      case "file_change":
        return mapFileChange(phase, item);
      case "command_execution":
        return mapCommand(phase, item);
      // mcp_tool_call / web_search / todo_list / collab_tool_call / error（item 级）
      // 五型在统一事件里没有对应骨架，按 §7.1 记入原始日志即可。
      default:
        return [raw(item, `item.${phase}：该 item 类型只记原始日志`)];
    }
  }

  function mapThreadStarted(native: Record<string, unknown>): AgentEvent[] {
    const threadId = asString(native["thread_id"]);
    if (threadId === undefined) {
      return [raw(native, "thread.started 缺 thread_id")];
    }
    return [
      {
        kind: "session_start",
        // ID 与 cwd 成对（设计文档 §10.2 规则 3）：resume 轮没有 -C 参数，
        // 工作根只能靠子进程 cwd，登记时就必须把 cwd 钉在一起。
        native: { nativeSessionId: threadId as NativeSessionId, cwd },
        ...(model === undefined ? {} : { model }),
      },
    ];
  }

  /** turn.completed：按阻断证据决定 end 是否可以报成功（文件头约定 1）。 */
  function registerCompleted(native: Record<string, unknown>): void {
    const usage = mapUsage(native["usage"]);
    if (blocked.length === 0) {
      pending = { reason: "completed", ...(usage === undefined ? {} : { usage }) };
      return;
    }
    const listed = blocked.slice(0, BLOCKAGE_EXCERPT_COUNT).join("；");
    const more = blocked.length > BLOCKAGE_EXCERPT_COUNT ? ` 等 ${blocked.length} 项` : "";
    pending = {
      reason: "failed",
      ...(usage === undefined ? {} : { usage }),
      message: `Codex 以 turn.completed 收尾，但本轮有动作被环境阻断（沙箱/审批），任务未完成：${listed}${more}`,
    };
  }

  function registerFailed(native: Record<string, unknown>): void {
    const error = native["error"];
    const message = isJsonObject(error) ? asString(error["message"]) : undefined;
    pending = {
      reason: "failed",
      message: message ?? "turn.failed（Codex 未给出错误文本）",
    };
  }

  return {
    map(record: JsonlRecord): readonly AgentEvent[] {
      if (!record.ok) {
        // 脏行（人类可读警告混入等）：原文 + 原因上交，解析继续（§7.2）。
        return [raw(record.raw, record.reason)];
      }
      const native = record.value;
      let events: readonly AgentEvent[];
      switch (nativeEventType(native)) {
        case "thread.started":
          events = mapThreadStarted(native);
          break;
        case "turn.started":
          events = [raw(native, "turn.started：无对应统一事件，只记原始日志")];
          break;
        case "turn.completed":
          registerCompleted(native);
          return [];
        case "turn.failed":
          registerFailed(native);
          return [];
        case "item.started":
          events = mapItem("started", native);
          break;
        case "item.updated":
          events = mapItem("updated", native);
          break;
        case "item.completed":
          events = mapItem("completed", native);
          break;
        case "error":
          // 流级 error：多为重试提示（fixture exec-error-auth.jsonl 的 401
          // 重试），非致命，按 §7.1 记原始日志并可作 UI 警示条。
          events = [raw(native, "流级 error 事件：记原始日志 / UI 警示条")];
          break;
        default:
          events = [raw(native, "未归类的顶层事件类型（词汇漂移，见 codex.md §7.2）")];
      }
      for (const event of events) {
        const blockage = blockageOf(event);
        if (blockage !== undefined) {
          blocked.push(blockage);
        }
      }
      return events;
    },

    finalize(outcome: CodexStreamOutcome): readonly AgentEvent[] {
      const exitCode = outcome.exitCode === null ? {} : { exitCode: outcome.exitCode };
      if (pending !== null) {
        const end: EndEvent = {
          kind: "end",
          reason: pending.reason,
          ...(pending.usage === undefined ? {} : { usage: pending.usage }),
          ...(pending.message === undefined ? {} : { message: pending.message }),
          ...exitCode,
        };
        return [end];
      }
      // 兜底（codex.md §4 实测：强杀后 stdout 直接截断，不出任何终止事件）。
      const reason: RunEndReason = outcome.cancelled
        ? "cancelled"
        : outcome.spawnFailed
          ? "failed"
          : "crashed";
      const note = outcome.spawnFailed
        ? "codex 进程未能启动"
        : `codex 进程结束但未收到 turn.completed / turn.failed（事件流被截断，判定为 ${reason}）`;
      const end: EndEvent = {
        kind: "end",
        reason,
        message: outcome.error === null ? note : `${note}：${outcome.error}`,
        ...exitCode,
      };
      return [end];
    },

    sawTerminalEvent(): boolean {
      return pending !== null;
    },

    blockages(): readonly string[] {
      return [...blocked];
    },
  };
}
