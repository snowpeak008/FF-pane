/**
 * session store（W3.1c 定形 → T4.2 接通流式执行）。
 *
 * 回答的问题（项目设计计划 §11.2）：我正在和谁讨论什么。
 * 装什么：会话页的 UI 状态 + Agent 流式执行的订阅缓存（唯一允许把服务端推送内容
 *   放进 store 的场景，§6.1 流式渲染是数据行为）。
 * 不装什么：消息历史（归 Agent 自己，§10.2 规则 3）、Profile/模型/权限摘要（随查随用）。
 *
 * T4.2 把主进程的 session:event 流接入本 store：全局桥（SessionEventBridge）唯一订阅、
 * 调 ingestSessionEvent 归并；会话页与任务页只读本 store。单活跃轮模型：以 streamingTurn.turnId
 * 标识当前在飞轮，非当前轮的事件被忽略。本 store 不持久化。
 */
import type { LocalSessionId, ModelId, Role, RunEndReason, RunId } from "@ff-pane/shared";
import { create } from "zustand";
import type { SessionStreamEvent } from "../../../shared-ipc/contracts";

/** 右侧可折叠栏的标签（§11.2：当前计划概要 + 进行中任务）。 */
export type SessionSidePanelTab = "plan" | "tasks";

/**
 * Agent 流式输出的订阅缓存：事件推送的增量累积，没有可查询的等价物。
 * done 为 true 后由页面工单清空，不长期驻留。
 */
export interface StreamingTurn {
  /** 本轮输出的稳定标识（用于流式追加时的 React key 与事件归属判定）。 */
  readonly turnId: string;
  /** 已累积的文本（增量追加，不整段替换）。 */
  readonly text: string;
  /** 是否已收到结束事件。 */
  readonly done: boolean;
}

/** 会话轮的执行状态（§11.2 状态条 / §7 权限交互）。 */
export type TurnStatus = "idle" | "running" | "awaiting-permission" | "ended";

/** 上浮的权限请求（§7 用户二选一），由会话页横幅呈现。 */
export interface PendingPermission {
  readonly turnId: string;
  readonly requestId: string;
  readonly summary: string;
  readonly detail?: string;
  readonly diff?: string;
}

/** 轮结束标记：供任务页等据此刷新（endedTurnSeq 单调递增触发 effect）。 */
export interface EndedTurnMarker {
  readonly turnId: string;
  readonly reason: RunEndReason;
  readonly runId?: RunId;
}

export interface SessionUiState {
  /** 当前会话（null = 尚未开始会话，页面显示空态）。 */
  readonly activeSessionId: LocalSessionId | null;
  /** 底部输入框草稿（未发送内容，切页不丢）。 */
  readonly composerDraft: string;
  /** 右侧栏是否展开由 ui store 管，这里只管展开时选中哪个标签。 */
  readonly sidePanelTab: SessionSidePanelTab;
  /** 消息级操作（存入知识库 / 提为记忆候选）的当前目标消息。 */
  readonly focusedMessageId: string | null;
  /** 流式输出订阅缓存（无进行中输出时为 null）。 */
  readonly streamingTurn: StreamingTurn | null;
  /** 当前轮执行状态。 */
  readonly turnStatus: TurnStatus;
  /** 当前轮角色（planner / worker）。 */
  readonly turnRole: Role | null;
  /** 当前轮使用的模型（Runtime 报出或 Profile 指定）。 */
  readonly turnModel: ModelId | null;
  /** 当前轮的错误信息（结束原因非 completed 时的原文）。 */
  readonly turnError: string | null;
  /** 最近一次动作摘要（文件改动 / 命令），用于状态条轻量展示。 */
  readonly lastActivity: string | null;
  /** 待批准的权限请求（null = 无）。 */
  readonly pendingPermission: PendingPermission | null;
  /** 轮结束计数（单调递增，供页面 effect 触发刷新）。 */
  readonly endedTurnSeq: number;
  /** 最近结束的轮信息。 */
  readonly lastEndedTurn: EndedTurnMarker | null;
}

export interface SessionUiActions {
  readonly setActiveSessionId: (sessionId: LocalSessionId | null) => void;
  readonly setComposerDraft: (draft: string) => void;
  readonly clearComposerDraft: () => void;
  readonly setSidePanelTab: (tab: SessionSidePanelTab) => void;
  readonly setFocusedMessageId: (messageId: string | null) => void;
  /** 本地发起一轮：重置流式缓存并进入 running（在 session:start 前调用）。 */
  readonly startLocalTurn: (turnId: string, role: Role) => void;
  /** 发起被拒 / 立即失败：标记该轮错误（turnId 匹配时）。 */
  readonly failLocalTurn: (turnId: string, message: string) => void;
  /** 订阅回调调用：归并一条主进程会话事件。 */
  readonly ingestSessionEvent: (event: SessionStreamEvent) => void;
  /** 回执权限后清空待批准（状态回到 running）。 */
  readonly clearPendingPermission: () => void;
  /** 切换会话时清空全部会话级 UI 状态。 */
  readonly resetSessionUi: () => void;
}

export type SessionStore = SessionUiState & SessionUiActions;

/** 初始状态：页面工单直接展开使用，保证形态与本文件一致。 */
export const INITIAL_SESSION_UI_STATE: SessionUiState = {
  activeSessionId: null,
  composerDraft: "",
  sidePanelTab: "plan",
  focusedMessageId: null,
  streamingTurn: null,
  turnStatus: "idle",
  turnRole: null,
  turnModel: null,
  turnError: null,
  lastActivity: null,
  pendingPermission: null,
  endedTurnSeq: 0,
  lastEndedTurn: null,
};

/** 当前轮 ID（以流式缓存为准）。 */
function activeTurnId(state: SessionUiState): string | null {
  return state.streamingTurn?.turnId ?? null;
}

export const useSessionStore = create<SessionStore>()((set) => ({
  ...INITIAL_SESSION_UI_STATE,
  setActiveSessionId: (sessionId) => {
    set({ activeSessionId: sessionId });
  },
  setComposerDraft: (draft) => {
    set({ composerDraft: draft });
  },
  clearComposerDraft: () => {
    set({ composerDraft: "" });
  },
  setSidePanelTab: (tab) => {
    set({ sidePanelTab: tab });
  },
  setFocusedMessageId: (messageId) => {
    set({ focusedMessageId: messageId });
  },
  startLocalTurn: (turnId, role) => {
    set({
      streamingTurn: { turnId, text: "", done: false },
      turnStatus: "running",
      turnRole: role,
      turnModel: null,
      turnError: null,
      lastActivity: null,
      pendingPermission: null,
    });
  },
  failLocalTurn: (turnId, message) => {
    set((state) =>
      activeTurnId(state) === turnId
        ? {
            turnStatus: "ended",
            turnError: message,
            pendingPermission: null,
            streamingTurn:
              state.streamingTurn !== null ? { ...state.streamingTurn, done: true } : null,
          }
        : state,
    );
  },
  ingestSessionEvent: (event) => {
    set((state) => {
      const active = activeTurnId(state);
      // "started" 采纳为当前轮（本地未预置时也接管，保证健壮）
      if (event.kind === "started") {
        const base =
          active === event.turnId && state.streamingTurn !== null
            ? state.streamingTurn
            : { turnId: event.turnId, text: "", done: false };
        return {
          streamingTurn: base,
          turnStatus: "running",
          turnRole: event.role,
          turnModel: event.model ?? null,
          turnError: null,
          pendingPermission: null,
        };
      }
      // 非当前轮的事件忽略（陈旧 / 其他轮）
      if (event.turnId !== active || state.streamingTurn === null) {
        return state;
      }
      switch (event.kind) {
        case "text":
          return event.channel === "answer"
            ? {
                streamingTurn: {
                  ...state.streamingTurn,
                  text: state.streamingTurn.text + event.delta,
                },
              }
            : state;
        case "file-change":
          return { lastActivity: `${event.changeKind} ${event.path}` };
        case "command":
          return { lastActivity: `$ ${event.command}` };
        case "permission-request":
          return {
            turnStatus: "awaiting-permission",
            pendingPermission: {
              turnId: event.turnId,
              requestId: event.requestId,
              summary: event.summary,
              ...(event.detail !== undefined ? { detail: event.detail } : {}),
              ...(event.diff !== undefined ? { diff: event.diff } : {}),
            },
          };
        case "end":
          return {
            streamingTurn: { ...state.streamingTurn, done: true },
            turnStatus: "ended",
            turnError: event.reason === "completed" ? null : (event.message ?? event.reason),
            pendingPermission: null,
            endedTurnSeq: state.endedTurnSeq + 1,
            lastEndedTurn: {
              turnId: event.turnId,
              reason: event.reason,
              ...(event.runId !== undefined ? { runId: event.runId } : {}),
            },
          };
        default:
          return state;
      }
    });
  },
  clearPendingPermission: () => {
    set((state) =>
      state.pendingPermission !== null ? { pendingPermission: null, turnStatus: "running" } : state,
    );
  },
  resetSessionUi: () => {
    set(INITIAL_SESSION_UI_STATE);
  },
}));
