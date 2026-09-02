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
 *
 * T8.2b-b 增加回放：historyMessages 装 transcript 回放的历史消息（单独字段，不与在飞轮
 * 混存）；轮次正常结束时把完成轮固化进 historyMessages（fold-on-end——比重取 transcript
 * 少一次 IPC 且不闪烁），页面合流时以 turnId 去重（同轮不双份）。replay 记录续接横幅
 * 需要的上下文（预判方式 / 坏行数）；autoResumeDoneRoot 保证「自动续接每项目只做一次」，
 * 「新建会话」后不会被 effect 再次拉回旧会话。
 */
import type {
  LocalSessionId,
  ModelId,
  PlanVersion,
  Role,
  RunEndReason,
  RunId,
  SessionResumeKind,
} from "@ff-pane/shared";
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
  /** 计划生成轮（T4.6）落盘的计划版本；供会话页 toast + 跳计划页。 */
  readonly planVersion?: PlanVersion;
}

/**
 * 历史消息（T8.2b-b）：transcript 回放 + 轮次结束固化的已完成消息。
 * 与 streamingTurn 分开存——单活跃轮模型不变，历史是只增列表。
 * id 取 `<turnId>:user` / `<turnId>:assistant`，与页面为在飞轮派生的视图 id 同构，
 * 固化瞬间 React key 不变、不重挂不闪烁。
 */
export interface SessionHistoryMessage {
  readonly id: string;
  /** 所属轮次（与 TranscriptEntry.turnId / session:event 的 turnId 同源，去重键）。 */
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** 该轮被中断（assistant_message{partial} 或 turn_end{interrupted}），界面显式标注。 */
  readonly interrupted?: true;
}

/** 续接横幅的上下文（T8.2b-b）：自动选中最近会话并回放后登记。 */
export interface ReplayContext {
  /** 被回放的会话（横幅只在它仍是当前会话时显示）。 */
  readonly sessionId: LocalSessionId;
  /** 预判的续接方式（页面经 predictResumeKind 算出；实际以下一轮 started.resumeKind 为准）。 */
  readonly predictedKind: Extract<SessionResumeKind, "native" | "context_rebuild">;
  /** 回放本中无法解析被跳过的行数（>0 时页脚如实标注）。 */
  readonly skippedLines: number;
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
  /**
   * 本轮恢复方式（T4.3，§10.3 状态条「会话类型」标注）：
   * null = 全新会话首轮；否则为原生恢复 / 上下文重建。
   */
  readonly turnResumeKind: SessionResumeKind | null;
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
  /** 历史消息（T8.2b-b：回放 + 固化的已完成轮），按时间顺序。 */
  readonly historyMessages: readonly SessionHistoryMessage[];
  /** 续接横幅上下文（null = 本会话不是自动续接来的 / 已新建会话）。 */
  readonly replay: ReplayContext | null;
  /**
   * 已做过自动续接的项目根（null = 尚未做过）。进入会话页只对未处理过的项目自动
   * 选中最近会话；「新建会话」把当前项目记在这里，防止 effect 把用户拉回旧会话。
   */
  readonly autoResumeDoneRoot: string | null;
}

export interface SessionUiActions {
  readonly setActiveSessionId: (sessionId: LocalSessionId | null) => void;
  readonly setComposerDraft: (draft: string) => void;
  /**
   * 往草稿末尾追加一段（知识库引用插入，§8.3.5）。
   * **追加而不是覆盖**：用户往往已经写了半句话，正等着把资料垫进去；
   * 覆盖会让「从知识库插入」变成一个会吃掉输入的按钮。
   */
  readonly appendComposerDraft: (text: string) => void;
  readonly clearComposerDraft: () => void;
  readonly setSidePanelTab: (tab: SessionSidePanelTab) => void;
  readonly setFocusedMessageId: (messageId: string | null) => void;
  /**
   * 本地发起一轮：重置流式缓存并进入 running（在 session:start 前调用）。
   * userText（T8.2b-b）：用户可见的本轮输入，给出即追加进历史消息（回放后新发言
   * 紧跟在历史之后；与主进程 transcript 的 user_message 同源同语义）。
   */
  readonly startLocalTurn: (turnId: string, role: Role, userText?: string) => void;
  /** 发起被拒 / 立即失败：标记该轮错误（turnId 匹配时）。 */
  readonly failLocalTurn: (turnId: string, message: string) => void;
  /** 订阅回调调用：归并一条主进程会话事件。 */
  readonly ingestSessionEvent: (event: SessionStreamEvent) => void;
  /** 回执权限后清空待批准（状态回到 running）。 */
  readonly clearPendingPermission: () => void;
  /** 切换会话时清空全部会话级 UI 状态。 */
  readonly resetSessionUi: () => void;
  /**
   * 载入 transcript 回放（T8.2b-b）：设当前会话 + 历史消息 + 横幅上下文，并把该项目
   * 记为已自动续接。只在无在飞轮时生效（有在飞轮说明用户已经在聊，回放不该覆盖现场）。
   */
  readonly loadReplay: (params: {
    readonly projectRoot: string;
    readonly replay: ReplayContext;
    readonly messages: readonly SessionHistoryMessage[];
  }) => void;
  /** 标记某项目已处理过自动续接（无历史会话时也要记，防止每次进页都重查）。 */
  readonly markAutoResumeDone: (projectRoot: string) => void;
  /**
   * 新建会话（T8.2b-b 续接横幅按钮）：清空当前会话 / 历史消息 / 横幅与在飞缓存，
   * 回到全新会话态；autoResumeDoneRoot 保留——用户显式要求新会话，不许 effect 拉回旧的。
   */
  readonly startNewSession: () => void;
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
  turnResumeKind: null,
  turnError: null,
  lastActivity: null,
  pendingPermission: null,
  endedTurnSeq: 0,
  lastEndedTurn: null,
  historyMessages: [],
  replay: null,
  autoResumeDoneRoot: null,
};

/**
 * 把结束的在飞轮固化成历史消息（fold-on-end）：answer 文本非空才成为 assistant 历史条目；
 * 结束原因为 interrupted 时带中断标注（正常路径不会——interrupted 只出现在退出/崩溃，
 * 但事件形状允许，如实处理）。user 侧的输入在发起时已由页面写入 historyMessages。
 */
function foldEndedTurn(
  history: readonly SessionHistoryMessage[],
  turn: StreamingTurn,
  reason: RunEndReason,
): readonly SessionHistoryMessage[] {
  if (turn.text.length === 0) {
    return history;
  }
  // 同 turnId 去重：重复 end 事件 / 已固化过的轮不再追加
  if (history.some((m) => m.turnId === turn.turnId && m.role === "assistant")) {
    return history;
  }
  return [
    ...history,
    {
      id: `${turn.turnId}:assistant`,
      turnId: turn.turnId,
      role: "assistant",
      text: turn.text,
      ...(reason === "interrupted" ? { interrupted: true as const } : {}),
    },
  ];
}

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
  appendComposerDraft: (text) => {
    set((state) => ({
      composerDraft:
        state.composerDraft.trim() === "" ? text : `${state.composerDraft.trimEnd()}\n\n${text}`,
    }));
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
  startLocalTurn: (turnId, role, userText) => {
    set((state) => ({
      streamingTurn: { turnId, text: "", done: false },
      turnStatus: "running",
      turnRole: role,
      turnModel: null,
      turnResumeKind: null,
      turnError: null,
      lastActivity: null,
      pendingPermission: null,
      // 上一轮的流式缓存被本轮覆盖前，其内容已在 end 事件时固化进 historyMessages
      ...(userText !== undefined && userText.length > 0
        ? {
            historyMessages: [
              ...state.historyMessages,
              { id: `${turnId}:user`, turnId, role: "user" as const, text: userText },
            ],
          }
        : {}),
    }));
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
          turnResumeKind: event.resumeKind ?? null,
          // 会话类型标注 + 续接会话据 started 事件登记为当前会话（T4.3）
          activeSessionId: event.sessionId,
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
            // 固化进历史后清空流式缓存（T8.2b-b fold-on-end）：历史条目 id 与页面为在飞轮
            // 派生的视图 id 同构（`${turnId}:assistant`），React key 不变、切换瞬间不闪烁
            historyMessages: foldEndedTurn(
              state.historyMessages,
              state.streamingTurn,
              event.reason,
            ),
            streamingTurn: null,
            turnStatus: "ended",
            turnError: event.reason === "completed" ? null : (event.message ?? event.reason),
            pendingPermission: null,
            endedTurnSeq: state.endedTurnSeq + 1,
            lastEndedTurn: {
              turnId: event.turnId,
              reason: event.reason,
              ...(event.runId !== undefined ? { runId: event.runId } : {}),
              ...(event.planVersion !== undefined ? { planVersion: event.planVersion } : {}),
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
  loadReplay: ({ projectRoot, replay, messages }) => {
    set((state) =>
      state.streamingTurn === null
        ? {
            activeSessionId: replay.sessionId,
            historyMessages: messages,
            replay,
            autoResumeDoneRoot: projectRoot,
          }
        : { autoResumeDoneRoot: projectRoot },
    );
  },
  markAutoResumeDone: (projectRoot) => {
    set({ autoResumeDoneRoot: projectRoot });
  },
  startNewSession: () => {
    set({
      activeSessionId: null,
      historyMessages: [],
      replay: null,
      streamingTurn: null,
      turnStatus: "idle",
      turnRole: null,
      turnModel: null,
      turnResumeKind: null,
      turnError: null,
      lastActivity: null,
      pendingPermission: null,
    });
  },
}));
