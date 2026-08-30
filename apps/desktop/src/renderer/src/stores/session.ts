/**
 * session store 的类型骨架（W3.1c 定形，实现归 W3.3a/W3.3b 会话页工单）。
 *
 * 本文件只有类型：状态形态与 action 签名在这里定死，页面工单照签名实现，
 * 不得增删状态字段的语义（要改先改本文件，作为一次独立变更）。
 *
 * 回答的问题（项目设计计划 §11.2）：我正在和谁讨论什么。
 * 装什么：会话页的 UI 状态 + Agent 流式输出的订阅缓存。
 * 不装什么：消息历史（归 Agent 自己，工作台只登记 native session id，§10.2 规则 3）、
 *          Profile/模型/权限摘要（经 IPC 查询，随查随用）。
 *
 * 实现模板（页面工单）：
 *   export const useSessionStore = create<SessionStore>()((set) => ({ ...INITIAL, ...actions }));
 * 本 store 不持久化：草稿与流式缓存跨会话保留没有意义，重启即清空。
 */
import type { LocalSessionId } from "@ff-pane/shared";

/** 右侧可折叠栏的标签（§11.2：当前计划概要 + 进行中任务）。 */
export type SessionSidePanelTab = "plan" | "tasks";

/**
 * Agent 流式输出的订阅缓存：唯一允许把"服务端来的内容"放进 store 的场景——
 * 它是事件推送的增量累积，没有可查询的等价物（§6.1 流式渲染是数据行为，必须做）。
 * done 为 true 后由页面工单落盘/清空，不长期驻留。
 */
export interface StreamingTurn {
  /** 本轮输出的稳定标识（用于流式追加时的 React key）。 */
  readonly turnId: string;
  /** 已累积的文本（增量追加，不整段替换）。 */
  readonly text: string;
  /** 是否已收到结束事件。 */
  readonly done: boolean;
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
}

export interface SessionUiActions {
  readonly setActiveSessionId: (sessionId: LocalSessionId | null) => void;
  readonly setComposerDraft: (draft: string) => void;
  readonly clearComposerDraft: () => void;
  readonly setSidePanelTab: (tab: SessionSidePanelTab) => void;
  readonly setFocusedMessageId: (messageId: string | null) => void;
  /** 订阅回调调用：开始一轮流式输出。 */
  readonly beginStreamingTurn: (turnId: string) => void;
  /** 订阅回调调用：追加增量（**追加**，不替换整段）。 */
  readonly appendStreamingText: (turnId: string, delta: string) => void;
  /** 订阅回调调用：本轮结束。 */
  readonly finishStreamingTurn: (turnId: string) => void;
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
};
