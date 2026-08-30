/**
 * tasks store 的类型骨架（W3.1c 定形，实现归 W3.6a/W3.6b 任务页工单）。
 *
 * 回答的问题（项目设计计划 §11.4）：现在做到哪了。
 * 装什么：按状态分列视图的 UI 状态 + Run 进度的订阅缓存。
 * 不装什么：任务列表本体与任务合同（经 IPC 查询，随查随用，页面卸载即丢）。
 *
 * 为什么进度是订阅缓存而不是查询结果：Run 执行属 §6.1「> 10s 转后台任务」，
 * 进度只能靠主进程推送；页面离开后仍需在别处显示徽章，所以缓存放在 store 里。
 */
import type { RunId, TaskId, TaskStatus } from "@ff-pane/shared";

/** Run 进度的订阅缓存条目（由事件推送更新，不查询）。 */
export interface RunProgressSnapshot {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly status: TaskStatus;
  /** 最近一条进度摘要（一行，供任务卡片显示）。 */
  readonly summary: string;
  /** 最近更新时间（epoch 毫秒）。 */
  readonly updatedAt: number;
}

export interface TasksUiState {
  /** 焦点任务（Ctrl+Enter 派发、Ctrl+Shift+A 接受的作用对象）。 */
  readonly focusedTaskId: TaskId | null;
  /** 已折叠的状态列（§11.4 六列视图；cancelled 默认不成列）。 */
  readonly collapsedStatusColumns: readonly TaskStatus[];
  /** 列表内搜索/过滤词（"/" 聚焦的那个搜索框）。 */
  readonly filterQuery: string;
  /** 只看阻塞任务（blocked 置顶待处理，§11.4）。 */
  readonly blockedOnly: boolean;
  /** Run 进度订阅缓存，按 taskId 索引。 */
  readonly runProgress: Readonly<Record<string, RunProgressSnapshot>>;
}

export interface TasksUiActions {
  readonly setFocusedTaskId: (taskId: TaskId | null) => void;
  readonly toggleStatusColumn: (status: TaskStatus) => void;
  readonly setFilterQuery: (query: string) => void;
  readonly setBlockedOnly: (blockedOnly: boolean) => void;
  /** 订阅回调调用：合并一条进度快照（同 taskId 覆盖）。 */
  readonly applyRunProgress: (snapshot: RunProgressSnapshot) => void;
  /** 任务进入终态后清掉它的进度缓存。 */
  readonly clearRunProgress: (taskId: TaskId) => void;
  readonly resetTasksUi: () => void;
}

export type TasksStore = TasksUiState & TasksUiActions;

export const INITIAL_TASKS_UI_STATE: TasksUiState = {
  focusedTaskId: null,
  collapsedStatusColumns: [],
  filterQuery: "",
  blockedOnly: false,
  runProgress: {},
};
