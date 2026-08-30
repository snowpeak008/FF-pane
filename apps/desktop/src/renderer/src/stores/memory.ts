/**
 * memory store 的类型骨架（W3.1c 定形，实现归 W3.5a/W3.5b 记忆页工单）。
 *
 * 回答的问题（项目设计计划 §11.6）：项目记住了什么。
 * 装什么：三标签页视图的 UI 状态 + 待审核候选数量的订阅缓存（标签角标）。
 * 不装什么：记忆条目本体与全文搜索结果（经 IPC 查询；万级条目要虚拟化，
 *          全量塞 store 只会让内存和渲染一起崩）。
 *
 * 候选数量为什么是订阅缓存：候选由 Agent 在任务收尾时产生（§8.1），
 * 用户可能正停在别的页面，角标必须靠推送更新，不能等用户进记忆页才刷新。
 */
import type { MemoryCategory, MemoryEntryId } from "@ff-pane/shared";

/** 三个标签页（§11.6）：项目记忆 / 共享记忆（习惯档案）/ 待审核候选。 */
export type MemoryTab = "project" | "shared" | "candidates";

export interface MemoryUiState {
  /** 当前标签页。 */
  readonly activeTab: MemoryTab;
  /** 全文搜索框内容（"/" 聚焦的那个）。 */
  readonly searchQuery: string;
  /** 类别过滤（null = 不过滤）。 */
  readonly categoryFilter: MemoryCategory | null;
  /** 焦点条目（Ctrl+Shift+A 通过 / Ctrl+Shift+X 拒绝的作用对象）。 */
  readonly focusedEntryId: MemoryEntryId | null;
  /** 是否展开已归档条目（默认只看 active）。 */
  readonly showArchived: boolean;
  /** 待审核候选数量的订阅缓存（标签角标数据源）。 */
  readonly pendingCandidateCount: number;
}

export interface MemoryUiActions {
  readonly setActiveTab: (tab: MemoryTab) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setCategoryFilter: (category: MemoryCategory | null) => void;
  readonly setFocusedEntryId: (entryId: MemoryEntryId | null) => void;
  readonly setShowArchived: (showArchived: boolean) => void;
  /** 订阅回调调用：更新候选角标数量。 */
  readonly setPendingCandidateCount: (count: number) => void;
  readonly resetMemoryUi: () => void;
}

export type MemoryStore = MemoryUiState & MemoryUiActions;

export const INITIAL_MEMORY_UI_STATE: MemoryUiState = {
  activeTab: "project",
  searchQuery: "",
  categoryFilter: null,
  focusedEntryId: null,
  showArchived: false,
  pendingCandidateCount: 0,
};
