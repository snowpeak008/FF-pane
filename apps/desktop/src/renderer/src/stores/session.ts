/**
 * session store（W3.1c 定形 → T4.2 接通流式执行 → T8.3b 多轮并发）。
 *
 * 回答的问题（项目设计计划 §11.2）：我正在和谁讨论什么。
 * 装什么：会话页的 UI 状态 + Agent 流式执行的订阅缓存（唯一允许把服务端推送内容
 *   放进 store 的场景，§6.1 流式渲染是数据行为）。
 * 不装什么：消息历史（归 Agent 自己，§10.2 规则 3）、Profile/模型/权限摘要（随查随用）。
 *
 * T4.2 把主进程的 session:event 流接入本 store：全局桥（SessionEventBridge）唯一订阅、
 * 调 ingestSessionEvent 归并；会话页与任务页只读本 store。本 store 不持久化。
 *
 * T8.2b-b 增加回放：historyMessages 装 transcript 回放的历史消息（单独字段，不与在飞轮
 * 混存）；轮次正常结束时把完成轮固化进 historyMessages（fold-on-end——比重取 transcript
 * 少一次 IPC 且不闪烁），页面合流时以 turnId 去重（同轮不双份）。replay 记录续接横幅
 * 需要的上下文（预判方式 / 坏行数）；autoResumeDoneRoot 保证「自动续接每项目只做一次」，
 * 「新建会话」后不会被 effect 再次拉回旧会话。
 *
 * T8.3b 多轮并发：单 `streamingTurn` 改为 `activeTurns` Map（turnId → 流式态），事件按
 * turnId 分桶归并而不再忽略非当前轮。会话页仍是**单会话视图**（activeSessionId），
 * 只渲染当前会话的在飞轮；其他会话的并发轮（任务页派发的 Worker / 审查轮各开新会话）
 * 在后台照常累积、结束时照常递增 endedTurnSeq（任务页刷新依赖它），但不折进当前视图的
 * historyMessages——那是另一场对话，正文在磁盘 transcript 里，切过去回放即可见。
 * busy 语义随之收窄为「**当前会话**有在飞轮」（sessionBusy）：别的会话在飞不该锁死
 * 本会话的输入框。pendingPermission 改为 per-turn（多轮同时 blocked 各自有横幅），
 * 回执按 turnId 路由。
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

/** 会话轮的执行状态（§11.2 状态条 / §7 权限交互）。 */
export type TurnStatus = "idle" | "running" | "awaiting-permission" | "ended";

/** 上浮的权限请求（§7 用户二选一），由会话页横幅呈现（多轮各自一条）。 */
export interface PendingPermission {
  readonly turnId: string;
  readonly requestId: string;
  readonly summary: string;
  readonly detail?: string;
  readonly diff?: string;
}

/**
 * 一条在飞轮的流式态（T8.3b：turnId → 本结构的 Map，插入序即开始序）。
 * sessionId 在发起时取当前会话（可能为 null = 即将新建），started 事件报出真值后覆盖。
 * 结束（end / 发起被拒）即从 Map 移除——Map 里只有活轮，没有"已结束还占位"的态。
 */
export interface ActiveTurnView {
  readonly turnId: string;
  readonly sessionId: LocalSessionId | null;
  readonly role: Role;
  readonly model: ModelId | null;
  readonly resumeKind: SessionResumeKind | null;
  /** 已累积的 answer 文本（增量追加，不整段替换）。 */
  readonly text: string;
  /** 该轮上浮且未回执的权限请求（null = 无；awaiting 态由此派生）。 */
  readonly pendingPermission: PendingPermission | null;
}

/** 轮结束标记：供任务页等据此刷新（endedTurnSeq 单调递增触发 effect）。 */
export interface EndedTurnMarker {
  readonly turnId: string;
  readonly reason: RunEndReason;
  readonly runId?: RunId;
  /** 计划生成轮（T4.6）落盘的计划版本；供会话页 toast + 跳计划页。 */
  readonly planVersion?: PlanVersion;
}

/** 状态条在最近一轮结束后仍要展示的摘要（角色 / 模型 / 会话类型 + "已结束"）。 */
export interface EndedTurnView {
  readonly role: Role;
  readonly model: ModelId | null;
  readonly resumeKind: SessionResumeKind | null;
}

/**
 * 历史消息（T8.2b-b）：transcript 回放 + 轮次结束固化的已完成消息。
 * 与在飞轮分开存——历史是只增列表。
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
  /** 全部在飞轮的流式缓存（T8.3b：turnId → 流式态，跨会话；空 Map = 无在飞轮）。 */
  readonly activeTurns: ReadonlyMap<string, ActiveTurnView>;
  /** 最近一次动作摘要（文件改动 / 命令，仅当前会话的轮），用于状态条轻量展示。 */
  readonly lastActivity: string | null;
  /** 轮结束计数（单调递增，供页面 effect 触发刷新；所有会话的轮都计）。 */
  readonly endedTurnSeq: number;
  /** 最近结束的轮信息。 */
  readonly lastEndedTurn: EndedTurnMarker | null;
  /** 当前会话最近结束轮的状态条摘要（有在飞轮时不用它）。 */
  readonly lastEndedView: EndedTurnView | null;
  /** 历史消息（T8.2b-b：回放 + 固化的已完成轮，当前会话），按时间顺序。 */
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
   * 本地发起一轮：登记进在飞 Map（在 session:start 前调用；sessionId 取当前会话，
   * started 事件报出真值后覆盖）。userText（T8.2b-b）：用户可见的本轮输入，给出即
   * 追加进历史消息（与主进程 transcript 的 user_message 同源同语义）。
   */
  readonly startLocalTurn: (turnId: string, role: Role, userText?: string) => void;
  /** 发起被拒 / 立即失败：该轮从未起飞，直接移出在飞 Map（失败原因由调用方 toast）。 */
  readonly failLocalTurn: (turnId: string, message: string) => void;
  /** 订阅回调调用：归并一条主进程会话事件（按 turnId 分桶，T8.3b）。 */
  readonly ingestSessionEvent: (event: SessionStreamEvent) => void;
  /** 回执某轮的权限请求后清空其待批准（按 turnId 路由，T8.3b）。 */
  readonly clearPendingPermission: (turnId: string) => void;
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
   * 新建会话（T8.2b-b 续接横幅按钮）：清空当前会话 / 历史消息 / 横幅，回到全新会话态；
   * autoResumeDoneRoot 保留——用户显式要求新会话，不许 effect 拉回旧的。
   * 在飞 Map 不清（T8.3b）：别的会话可能有并发轮在跑，清掉会丢它们的流式缓存与
   * 结束计数；本会话有在飞轮时横幅本就禁用，不会走到这里。
   */
  readonly startNewSession: () => void;
}

export type SessionStore = SessionUiState & SessionUiActions;

/** 空在飞表（初始态与重置共用同一引用，选择器比较不抖动）。 */
const EMPTY_TURNS: ReadonlyMap<string, ActiveTurnView> = new Map();

/** 初始状态：页面工单直接展开使用，保证形态与本文件一致。 */
export const INITIAL_SESSION_UI_STATE: SessionUiState = {
  activeSessionId: null,
  composerDraft: "",
  sidePanelTab: "plan",
  focusedMessageId: null,
  activeTurns: EMPTY_TURNS,
  lastActivity: null,
  endedTurnSeq: 0,
  lastEndedTurn: null,
  lastEndedView: null,
  historyMessages: [],
  replay: null,
  autoResumeDoneRoot: null,
};

/**
 * 某轮是否属于当前会话视图：sessionId 相符，或尚未被 started 事件认领
 * （null = 本页刚发起、会话即将由主进程指派——按当前视图计，busy 语义才不漏窗口期）。
 */
function belongsToSession(turn: ActiveTurnView, activeSessionId: LocalSessionId | null): boolean {
  return turn.sessionId === null || turn.sessionId === activeSessionId;
}

/** 当前会话的在飞轮（开始序）。会话页消息合流与状态条的数据源。 */
export function currentSessionTurns(
  turns: ReadonlyMap<string, ActiveTurnView>,
  activeSessionId: LocalSessionId | null,
): readonly ActiveTurnView[] {
  return [...turns.values()].filter((turn) => belongsToSession(turn, activeSessionId));
}

/**
 * busy 语义（T8.3b 重定义）：**当前会话**有在飞轮才算忙——Composer 禁发、横幅禁
 * 新建、恢复列表隐藏都以此为准。别的会话的并发轮（任务页派发的 Worker）不锁本会话。
 */
export function sessionBusy(
  turns: ReadonlyMap<string, ActiveTurnView>,
  activeSessionId: LocalSessionId | null,
): boolean {
  return currentSessionTurns(turns, activeSessionId).length > 0;
}

/** 全部在飞轮的待批权限请求（跨会话，开始序）：多轮同时 blocked 时各自一条横幅。 */
export function pendingPermissionsOf(
  turns: ReadonlyMap<string, ActiveTurnView>,
): readonly PendingPermission[] {
  const out: PendingPermission[] = [];
  for (const turn of turns.values()) {
    if (turn.pendingPermission !== null) {
      out.push(turn.pendingPermission);
    }
  }
  return out;
}

/** 状态条视图：当前会话最新在飞轮优先，无在飞轮时退回最近结束轮的摘要。 */
export function sessionStatusView(
  turns: ReadonlyMap<string, ActiveTurnView>,
  activeSessionId: LocalSessionId | null,
  lastEndedView: EndedTurnView | null,
): {
  readonly role: Role | null;
  readonly model: ModelId | null;
  readonly resumeKind: SessionResumeKind | null;
  readonly status: TurnStatus;
} {
  const latest = currentSessionTurns(turns, activeSessionId).at(-1);
  if (latest !== undefined) {
    return {
      role: latest.role,
      model: latest.model,
      resumeKind: latest.resumeKind,
      status: latest.pendingPermission !== null ? "awaiting-permission" : "running",
    };
  }
  if (lastEndedView !== null) {
    return { ...lastEndedView, status: "ended" };
  }
  return { role: null, model: null, resumeKind: null, status: "idle" };
}

/**
 * 把结束的在飞轮固化成历史消息（fold-on-end）：answer 文本非空才成为 assistant 历史条目；
 * 结束原因为 interrupted 时带中断标注（正常路径不会——interrupted 只出现在退出/崩溃，
 * 但事件形状允许，如实处理）。user 侧的输入在发起时已由页面写入 historyMessages。
 *
 * 导出仅供单测直调：内部的同 turnId 去重守卫是防御码（正常路径经上游归属判定不可达，
 * T8.2b-b 验收 §3-1），链路测试红不了它，须直调两次钉住（主管理员裁定，2026-09-02）。
 */
export function foldEndedTurn(
  history: readonly SessionHistoryMessage[],
  turn: { readonly turnId: string; readonly text: string },
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

/** Map 的不可变更新（zustand 靠引用比较感知变化）。 */
function withTurn(
  turns: ReadonlyMap<string, ActiveTurnView>,
  turn: ActiveTurnView,
): ReadonlyMap<string, ActiveTurnView> {
  const next = new Map(turns);
  next.set(turn.turnId, turn);
  return next;
}

function withoutTurn(
  turns: ReadonlyMap<string, ActiveTurnView>,
  turnId: string,
): ReadonlyMap<string, ActiveTurnView> {
  if (!turns.has(turnId)) {
    return turns;
  }
  const next = new Map(turns);
  next.delete(turnId);
  return next;
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
      activeTurns: withTurn(state.activeTurns, {
        turnId,
        sessionId: state.activeSessionId,
        role,
        model: null,
        resumeKind: null,
        text: "",
        pendingPermission: null,
      }),
      lastActivity: null,
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
  failLocalTurn: (turnId, _message) => {
    // 该轮从未起飞：不留"已结束"占位（空文本本就不会固化），拒绝原因由调用方 toast。
    set((state) => ({ activeTurns: withoutTurn(state.activeTurns, turnId) }));
  },
  ingestSessionEvent: (event) => {
    set((state) => {
      // "started" 认领 / 新建该轮，并把其会话设为当前视图（保持既有行为：派发即
      // 进入执行视图，§12——最后开始的轮定义"我正在和谁讨论"）。
      if (event.kind === "started") {
        const known = state.activeTurns.get(event.turnId);
        return {
          activeTurns: withTurn(state.activeTurns, {
            turnId: event.turnId,
            sessionId: event.sessionId,
            role: event.role,
            model: event.model ?? null,
            resumeKind: event.resumeKind ?? null,
            text: known?.text ?? "",
            pendingPermission: null,
          }),
          activeSessionId: event.sessionId,
        };
      }
      const turn = state.activeTurns.get(event.turnId);
      // 未登记轮的事件忽略（陈旧事件 / 已结束轮的迟到增量）
      if (turn === undefined) {
        return state;
      }
      const isCurrent = belongsToSession(turn, state.activeSessionId);
      switch (event.kind) {
        case "text":
          return event.channel === "answer"
            ? {
                activeTurns: withTurn(state.activeTurns, {
                  ...turn,
                  text: turn.text + event.delta,
                }),
              }
            : state;
        case "file-change":
          return isCurrent ? { lastActivity: `${event.changeKind} ${event.path}` } : state;
        case "command":
          return isCurrent ? { lastActivity: `$ ${event.command}` } : state;
        case "permission-request":
          return {
            activeTurns: withTurn(state.activeTurns, {
              ...turn,
              pendingPermission: {
                turnId: event.turnId,
                requestId: event.requestId,
                summary: event.summary,
                ...(event.detail !== undefined ? { detail: event.detail } : {}),
                ...(event.diff !== undefined ? { diff: event.diff } : {}),
              },
            }),
          };
        case "end":
          return {
            activeTurns: withoutTurn(state.activeTurns, event.turnId),
            // 只有当前会话的轮固化进历史（fold-on-end，T8.2b-b）：别的会话的并发轮
            // 是另一场对话，正文在其 transcript 里，不该混进当前视图。
            ...(isCurrent
              ? {
                  historyMessages: foldEndedTurn(state.historyMessages, turn, event.reason),
                  lastEndedView: {
                    role: turn.role,
                    model: turn.model,
                    resumeKind: turn.resumeKind,
                  },
                }
              : {}),
            // 结束计数所有会话都记：任务页靠它刷新 Worker / 审查轮的结果
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
  clearPendingPermission: (turnId) => {
    set((state) => {
      const turn = state.activeTurns.get(turnId);
      if (turn === undefined || turn.pendingPermission === null) {
        return state;
      }
      return { activeTurns: withTurn(state.activeTurns, { ...turn, pendingPermission: null }) };
    });
  },
  resetSessionUi: () => {
    set(INITIAL_SESSION_UI_STATE);
  },
  loadReplay: ({ projectRoot, replay, messages }) => {
    set((state) =>
      state.activeTurns.size === 0
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
      lastActivity: null,
      lastEndedView: null,
    });
  },
}));
