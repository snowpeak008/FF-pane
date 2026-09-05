/**
 * iFlow ACP session/update → 统一 AgentEvent 映射器（T8.6b）。
 *
 * 纯映射、零 I/O：输入是 T8.5a 协议层解析出的 AcpSessionUpdateView（fixture
 * real-acp-*.wire.jsonl 可直接回放），输出 AgentEvent 数组。与 grok-build 的
 * 差异（那边把 ACP wire 逆投影回 headless 记录喂旧 mapper）：iFlow **没有**可复用
 * 的 headless 映射器（0.5.19 headless 无结构化输出，调研 §3），本 mapper 就是
 * 一手消费 ACP 视图——iFlow 的 toolName / kind 在 wire 顶层（parse.ts 已建型），
 * diff 载荷自带 `fileDiff` 统一 diff 文本，无需自渲染。
 *
 * 三条硬约定（前两条与 grok mapper 同款，第三条是 iFlow 特有坑的防线）：
 * 1. **end 恰好一条且在最后**：终止事实（prompt 响应 stopReason / 协议错误）只
 *    登记，由 finalize() 统一收尾并带进程终局；
 * 2. **只有 end_turn 且零阻断才算成功**：cancelled → cancelled；其余 stopReason
 *    → failed 并留原文；
 * 3. **审批拒绝自记账**（调研 §9.3 坑 2，本适配器最要紧的防线）：iFlow 在权限
 *    请求被拒后**静默吞掉该工具**——无 tool_call 事件、无 failed 帧、prompt 照样
 *    end_turn。「这轮其实没干活」只能由权限桥自己记账：registerDenied() 从权限
 *    请求携带的 toolCall 明细合成一条 status="denied" 的动作事件（file_change /
 *    command），同时记入阻断清单——end_turn 到达时阻断非空即改判 failed。
 *    不能等 CLI 给信号，它只会说 end_turn。
 */

import type { ModelId, NativeSessionId, RunEndReason } from "@ff-pane/shared";
import type {
  AcpSessionUpdateView,
  AcpToolCallContentView,
  AcpToolCallView,
} from "../acp/index.js";
import type {
  AgentActionStatus,
  AgentEvent,
  EndEvent,
  FileChangeKind,
  SessionStartEvent,
} from "../events/index.js";
import { isJsonObject, toRawEvent } from "../events/index.js";
import { IFLOW_RUNTIME } from "./command.js";

/** ACP 工具类目里属于「改文件」的三种（写侧；edit 是 iFlow write_file 的实测类目）。 */
const FILE_TOOL_KINDS = new Set(["edit", "delete", "move"]);

/** ACP 工具状态 → 统一动作状态（iFlow 实测只见 pending/in_progress/completed）。 */
const TOOL_STATUS: Readonly<Record<string, AgentActionStatus>> = {
  pending: "started",
  in_progress: "started",
  completed: "completed",
  failed: "failed",
};

/** 阻断证据摘要最多列出的条目数（与 grok/codex 同口径）。 */
const BLOCKAGE_EXCERPT_COUNT = 3;

/**
 * 命令工具 title 的 cwd 描述后缀（真机形态：
 * `node -v [current working directory C:\…] (Check node version)`）。
 * 权限请求的 toolCall **不带 args**（实测，与 tool_call_update 不同），命令原文
 * 只能从 title 剥出——模式失配时退回整个 title（给人看的审批文案，宁多勿缺）。
 */
const TITLE_CWD_SUFFIX = /\s*\[current working directory [^\]]*\].*$/;

/** 从命令工具的 title 剥出命令原文（title 缺席返回 undefined）。 */
export function commandFromIFlowTitle(title: string | undefined): string | undefined {
  if (title === undefined || title === "") {
    return undefined;
  }
  const stripped = title.replace(TITLE_CWD_SUFFIX, "").trim();
  return stripped === "" ? title : stripped;
}

/** 流结束时的进程终局（适配器从 AgentProcessExit 翻译）。 */
export interface IFlowStreamOutcome {
  readonly cancelled: boolean;
  readonly spawnFailed: boolean;
  readonly exitCode: number | null;
  readonly error: string | null;
}

/** 一次工具调用的登记信息（tool_call 顶层带 toolName/kind，update 可缺）。 */
interface ToolState {
  toolName: string;
  kind: string;
  path?: string;
  command?: string;
  /** 是否已发过 started（命令类只发一次，防 in_progress 多帧重复）。 */
  startedEmitted: boolean;
}

/** 已登记待收尾的终止事实。 */
interface PendingTerminal {
  readonly reason: RunEndReason;
  readonly message?: string;
}

/** iFlow 事件映射器（有状态，一个实例只服务一轮）。 */
export interface IFlowEventMapper {
  /** 映射一条 session/update 视图。 */
  mapUpdate(view: AcpSessionUpdateView): readonly AgentEvent[];
  /**
   * 审批拒绝记账（约定 3）：从权限请求携带的 toolCall 合成 denied 动作事件并记
   * 阻断。由权限桥在回执 deny 之后调用——wire 上此后不会再有该工具的任何事件。
   */
  registerDenied(toolCall: AcpToolCallView): readonly AgentEvent[];
  /** 登记 prompt 响应的 stopReason（终止事实，收尾在 finalize）。 */
  registerPromptEnd(stopReason: string): void;
  /** 登记会话期协议错误（auth / loadSession / prompt 错误响应）。 */
  registerError(message: string): void;
  /** 是否已登记终止事实（适配器据此决定进程退出码是否还有信息量）。 */
  sawTerminalEvent(): boolean;
  /** 流结束收尾：文本 final + 恰好一条 end。 */
  finalize(outcome: IFlowStreamOutcome): readonly AgentEvent[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * 从 update 顶层或 content[].diff 条目的 args 里取 file_path（绝对路径优先）。
 * 导出供权限桥构造 write_path 载荷（acp-turn.ts）。
 */
export function iflowToolFilePath(toolCall: AcpToolCallView): string | undefined {
  const topArgs = toolCall.raw["args"];
  if (isJsonObject(topArgs)) {
    const fromTop = asString(topArgs["file_path"]);
    if (fromTop !== undefined) {
      return fromTop;
    }
  }
  for (const entry of toolCall.content) {
    if (entry.kind !== "diff") {
      continue;
    }
    const args = entry.raw["args"];
    const fromArgs = isJsonObject(args) ? asString(args["file_path"]) : undefined;
    // diff 视图的 path 是 CLI 给的相对形态（真机实测），args.file_path 才是绝对路径；
    // 都透传给权限/呈现层，归一化归 W2.7。
    return fromArgs ?? entry.path;
  }
  return toolCall.locations[0]?.path;
}

/** 从 update 顶层或 content 条目的 args 里取 command 原文。导出供权限桥用。 */
export function iflowToolCommand(toolCall: AcpToolCallView): string | undefined {
  const topArgs = toolCall.raw["args"];
  if (isJsonObject(topArgs)) {
    const fromTop = asString(topArgs["command"]);
    if (fromTop !== undefined) {
      return fromTop;
    }
  }
  for (const entry of toolCall.content) {
    const args = entry.raw["args"];
    const fromArgs = isJsonObject(args) ? asString(args["command"]) : undefined;
    if (fromArgs !== undefined) {
      return fromArgs;
    }
  }
  return undefined;
}

/** 第一个 diff 载荷（iFlow 的写文件完成帧恰带一条）。 */
function firstDiff(
  content: readonly AcpToolCallContentView[],
): Extract<AcpToolCallContentView, { kind: "diff" }> | undefined {
  for (const entry of content) {
    if (entry.kind === "diff") {
      return entry;
    }
  }
  return undefined;
}

/** content[] 里的文本片段汇总（命令输出藏在 content.content.text）。 */
function collectText(content: readonly AcpToolCallContentView[]): string {
  const parts: string[] = [];
  for (const entry of content) {
    if (entry.kind === "content" && entry.content.text !== undefined) {
      parts.push(entry.content.text);
    }
  }
  return parts.join("");
}

/** 新旧文本 → 变更类型（与 grok changeKindOf 同规则）。 */
function changeKindOf(diff: {
  readonly oldText?: string;
  readonly newText: string;
}): FileChangeKind {
  const oldText = diff.oldText ?? "";
  if (oldText === "" && diff.newText !== "") {
    return "add";
  }
  return diff.newText === "" ? "delete" : "update";
}

/** diff 载荷的 fileDiff 统一 diff 文本（iFlow 现成给出，调研 §8.3）。 */
export function fileDiffOf(
  diff: Extract<AcpToolCallContentView, { kind: "diff" }>,
): string | undefined {
  return asString(diff.raw["fileDiff"]);
}

/**
 * 创建映射器。session_start 不归本层——sessionId 在 session/new 响应即得，
 * 由 acp-turn 用 iflowSessionStart() 在轮次开头直接发出（ACP 相对 headless 的
 * 关键优势：中断轮也留得下续接凭据）。
 */
export function createIFlowEventMapper(): IFlowEventMapper {
  const tools = new Map<string, ToolState>();
  const blocked: string[] = [];
  let pending: PendingTerminal | null = null;
  let sawAnswerText = false;
  let sawReasoningText = false;

  function raw(native: unknown, note: string): AgentEvent {
    return toRawEvent(IFLOW_RUNTIME, native, note);
  }

  function statusOf(rawStatus: string | undefined): AgentActionStatus {
    if (rawStatus === undefined) {
      return "started";
    }
    return TOOL_STATUS[rawStatus] ?? "started";
  }

  function mapToolCall(toolCall: AcpToolCallView): AgentEvent[] {
    const existing = tools.get(toolCall.toolCallId);
    const state: ToolState = existing ?? {
      toolName: "",
      kind: "",
      startedEmitted: false,
    };
    // iFlow 的 tool_call 顶层直接带 toolName/kind（比 grok 藏 _meta 干净）；
    // update 帧可缺，缺了沿用登记值。
    const toolName = asString(toolCall.raw["toolName"]);
    if (toolName !== undefined) {
      state.toolName = toolName;
    }
    if (toolCall.toolKind !== undefined) {
      state.kind = toolCall.toolKind;
    }
    const path = iflowToolFilePath(toolCall);
    if (path !== undefined) {
      state.path = path;
    }
    const command = iflowToolCommand(toolCall);
    if (command !== undefined) {
      state.command = command;
    }
    tools.set(toolCall.toolCallId, state);

    const status = statusOf(toolCall.status);

    if (state.kind === "execute") {
      if (status === "started") {
        if (state.startedEmitted || state.command === undefined) {
          // 首帧 tool_call 不带 args（真机实测），等带 command 的 in_progress 再发
          return [raw(toolCall.raw, "命令类工具帧无新事实（无 command 或 started 已发）")];
        }
        state.startedEmitted = true;
        return [
          {
            kind: "command",
            command: state.command,
            status: "started",
            actionId: toolCall.toolCallId,
          },
        ];
      }
      const command = state.command ?? commandFromIFlowTitle(toolCall.title);
      if (command === undefined) {
        return [raw(toolCall.raw, "命令类完成帧无命令原文（args 与 title 都没有）")];
      }
      const output = collectText(toolCall.content);
      // 无结构化退出码（调研 §7 能力 4 = partial，gemini/qwen 同评级）：exitCode 恒缺席
      return [
        {
          kind: "command",
          command,
          status,
          ...(output === "" ? {} : { output }),
          actionId: toolCall.toolCallId,
        },
      ];
    }

    if (FILE_TOOL_KINDS.has(state.kind)) {
      const diff = firstDiff(toolCall.content);
      if (diff === undefined) {
        if (status === "failed") {
          // 失败帧常不带 diff：事实必须报出去，变更类型按「试图写入」记 update
          const path = state.path;
          if (path !== undefined) {
            return [
              {
                kind: "file_change",
                path,
                changeKind: "update",
                status,
                actionId: toolCall.toolCallId,
              },
              raw(toolCall.raw, "文件类失败帧无 diff 载荷，changeKind 按 update 记"),
            ];
          }
        }
        // pending/in_progress 帧只知道路径不知道新旧（changeKind 必填，猜即造假）：
        // 等带 diff 的完成帧（与 grok 同理）
        return [raw(toolCall.raw, "文件类工具帧无 diff 载荷，等完成帧再发 file_change")];
      }
      const path = state.path ?? diff.path;
      const fileDiff = fileDiffOf(diff);
      return [
        {
          kind: "file_change",
          path,
          changeKind: changeKindOf(diff),
          status,
          ...(fileDiff === undefined ? {} : { diff: fileDiff }),
          actionId: toolCall.toolCallId,
        },
      ];
    }

    return [raw(toolCall.raw, "该工具类目无对应统一事件，只记原始日志")];
  }

  function track(events: readonly AgentEvent[]): readonly AgentEvent[] {
    for (const event of events) {
      if (
        event.kind === "file_change" &&
        (event.status === "denied" || event.status === "failed")
      ) {
        blocked.push(
          `file_change ${event.path}：${event.status === "denied" ? "被拒绝" : "写入失败"}`,
        );
      }
      if (event.kind === "command" && event.status === "denied") {
        blocked.push(`command 被拒绝：${event.command.slice(0, 60)}`);
      }
    }
    return events;
  }

  return {
    mapUpdate(view: AcpSessionUpdateView): readonly AgentEvent[] {
      switch (view.kind) {
        case "agent_message_chunk": {
          const text = view.content.text;
          if (text === undefined) {
            return [raw(view.raw, "agent_message_chunk 无文本载荷")];
          }
          sawAnswerText = true;
          return [{ kind: "text", content: text, final: false, channel: "answer" }];
        }
        case "agent_thought_chunk": {
          // 真实后端的 thinking 形态待真机（调研 §10.4），事件形状按 ACP 规范建型
          const text = view.content.text;
          if (text === undefined) {
            return [raw(view.raw, "agent_thought_chunk 无文本载荷")];
          }
          sawReasoningText = true;
          return [{ kind: "text", content: text, final: false, channel: "reasoning" }];
        }
        case "user_message_chunk":
          return [raw(view.raw, "user_message_chunk：提示词回显，仅留档")];
        case "tool_call":
        case "tool_call_update":
          return track(mapToolCall(view.toolCall));
        case "plan":
          return [raw(view.raw, "plan：计划条目，仅留档（呈现层暂不消费）")];
        case "opaque":
          // available_commands_update 每次 prompt 前重发一遍（调研 §8.3），照单留档
          return [raw(view.raw, `未消费的 session/update 类型：${view.sessionUpdate}`)];
      }
    },

    registerDenied(toolCall: AcpToolCallView): readonly AgentEvent[] {
      const kind = toolCall.toolKind ?? "";
      if (kind === "execute") {
        const command =
          iflowToolCommand(toolCall) ?? commandFromIFlowTitle(toolCall.title) ?? "(命令原文不可得)";
        return track([
          { kind: "command", command, status: "denied", actionId: toolCall.toolCallId },
        ]);
      }
      if (FILE_TOOL_KINDS.has(kind)) {
        const diff = firstDiff(toolCall.content);
        const path = iflowToolFilePath(toolCall) ?? diff?.path;
        if (path !== undefined) {
          const fileDiff = diff === undefined ? undefined : fileDiffOf(diff);
          return track([
            {
              kind: "file_change",
              path,
              changeKind: diff === undefined ? "update" : changeKindOf(diff),
              status: "denied",
              ...(fileDiff === undefined ? {} : { diff: fileDiff }),
              actionId: toolCall.toolCallId,
            },
          ]);
        }
      }
      // 类目不明也要记账：阻断清单进 end 判定，事件流留 raw 证据
      blocked.push(`工具 ${asString(toolCall.raw["toolName"]) ?? toolCall.toolCallId} 被拒绝`);
      return [raw(toolCall.raw, "权限拒绝记账：无法合成动作事件（类目/路径不明），仅记阻断")];
    },

    registerPromptEnd(stopReason: string): void {
      if (stopReason === "cancelled") {
        pending = {
          reason: "cancelled",
          message:
            "iflow 以 stopReason=cancelled 收尾：本轮被取消（session/cancel 协议级取消，真机实测）",
        };
        return;
      }
      if (stopReason !== "end_turn") {
        pending = {
          reason: "failed",
          message: `iflow 以 stopReason=${stopReason === "" ? "(缺席)" : stopReason} 收尾，本轮未正常完成`,
        };
        return;
      }
      if (blocked.length === 0) {
        pending = { reason: "completed" };
        return;
      }
      // 约定 3 的收口：拒绝后 iFlow 只会 end_turn（无 failed 事件），阻断清单是唯一判据
      const listed = blocked.slice(0, BLOCKAGE_EXCERPT_COUNT).join("；");
      const more = blocked.length > BLOCKAGE_EXCERPT_COUNT ? ` 等 ${blocked.length} 项` : "";
      pending = {
        reason: "failed",
        message:
          `iflow 以 stopReason=end_turn 收尾，但本轮有动作被拒或失败：${listed}${more}` +
          "（iFlow 审批拒绝无 failed 事件，此判定由权限桥记账得出）",
      };
    },

    registerError(message: string): void {
      pending = { reason: "failed", message };
    },

    sawTerminalEvent(): boolean {
      return pending !== null;
    },

    finalize(outcome: IFlowStreamOutcome): readonly AgentEvent[] {
      const events: AgentEvent[] = [];
      if (sawAnswerText) {
        events.push({ kind: "text", content: "", final: true, channel: "answer" });
      }
      if (sawReasoningText) {
        events.push({ kind: "text", content: "", final: true, channel: "reasoning" });
      }
      const exitCode = outcome.exitCode === null ? {} : { exitCode: outcome.exitCode };
      if (pending !== null) {
        const end: EndEvent = {
          kind: "end",
          reason: pending.reason,
          ...(pending.message === undefined ? {} : { message: pending.message }),
          ...exitCode,
        };
        events.push(end);
        return events;
      }
      const reason: RunEndReason = outcome.cancelled
        ? "cancelled"
        : outcome.spawnFailed
          ? "failed"
          : "crashed";
      const note = outcome.spawnFailed
        ? "iflow 进程未能启动"
        : `iflow 进程结束但 prompt 未落定（事件流被截断，判定为 ${reason}）`;
      events.push({
        kind: "end",
        reason,
        message: outcome.error === null ? note : `${note}：${outcome.error}`,
        ...exitCode,
      });
      return events;
    },
  };
}

/** 构造 session_start 事件（sessionId 开轮即得，ACP 相对 headless 的关键优势）。 */
export function iflowSessionStart(
  sessionId: string,
  cwd: string,
  model?: ModelId,
): SessionStartEvent {
  return {
    kind: "session_start",
    native: { nativeSessionId: sessionId as NativeSessionId, cwd },
    ...(model === undefined ? {} : { model }),
  };
}
