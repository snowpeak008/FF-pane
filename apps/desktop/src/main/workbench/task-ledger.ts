/**
 * 任务账本的纯逻辑（T11.24）：状态、转换、排序、父子汇总、重合查找。
 * 不碰磁盘，存储见 task-ledger-store.ts。账本用户看不到，只给管理者后台用。
 */

import { randomUUID } from "node:crypto";

export const TASK_STATUSES = [
  "todo",
  "doing",
  "submitted",
  "rework",
  "blocked",
  "failed",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 已结束：移出 active，进归档。failed 不算结束，管理者必须处理。 */
export const TASK_CLOSED_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskOpen(status: TaskStatus): boolean {
  return !TASK_CLOSED_STATUSES.includes(status);
}

export interface TaskParty {
  readonly windowId: string;
  readonly title: string;
  readonly role: string;
}

export interface TaskEvent {
  readonly at: number;
  readonly by: string;
  readonly from?: TaskStatus;
  readonly to: TaskStatus;
  readonly note: string;
}

export interface TaskVerdict {
  /** pass 通过；rework 返工；waived 免检（必须写理由）。 */
  readonly result: "pass" | "rework" | "waived";
  readonly reason: string;
}

export interface LedgerTask {
  readonly id: string;
  /** 只拆一层：有 parentId 的不能再当父任务。 */
  readonly parentId?: string;
  readonly title: string;
  readonly detail: string;
  readonly acceptance: string;
  readonly status: TaskStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly createdBy: TaskParty;
  /** 来源，例如「用户临时提」。 */
  readonly source?: string;
  readonly assignee?: TaskParty;
  readonly brief?: string;
  /** 执行情况，一行最新的。 */
  readonly progress?: string;
  readonly reportedBy?: TaskParty;
  readonly reviewedBy?: TaskParty;
  readonly verdict?: TaskVerdict;
  /** 前一条任务的 id，没 done 就不派这一条。 */
  readonly after?: string;
  readonly events: readonly TaskEvent[];
}

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ["doing", "blocked", "cancelled"],
  doing: ["submitted", "blocked", "failed", "todo", "cancelled"],
  submitted: ["done", "rework", "cancelled"],
  rework: ["doing", "blocked", "cancelled"],
  blocked: ["doing", "todo", "failed", "cancelled"],
  failed: ["todo", "doing", "cancelled"],
  done: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function newTaskId(): string {
  return `t-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export type TransitionResult =
  | { readonly ok: true; readonly task: LedgerTask }
  | { readonly ok: false; readonly error: string };

/**
 * 改状态并在时间线追加一行。done 必须有通过或免检的结论；免检必须写理由。
 * 谁有权做哪一步由工具层判断，这里只管状态本身合不合法。
 */
export function applyTransition(
  task: LedgerTask,
  to: TaskStatus,
  by: string,
  note: string,
  now: number,
  verdict?: TaskVerdict,
): TransitionResult {
  if (!canTransition(task.status, to)) {
    return { ok: false, error: `任务现在是 ${task.status}，不能直接改成 ${to}。` };
  }
  const finalVerdict = verdict ?? task.verdict;
  if (to === "done") {
    if (finalVerdict === undefined || finalVerdict.result === "rework") {
      return { ok: false, error: "标完成要先有通过或免检的结论。" };
    }
    if (finalVerdict.result === "waived" && finalVerdict.reason.trim() === "") {
      return { ok: false, error: "免检必须写理由。" };
    }
  }
  const event: TaskEvent = { at: now, by, from: task.status, to, note: note.trim() };
  return {
    ok: true,
    task: {
      ...task,
      status: to,
      updatedAt: now,
      ...(verdict !== undefined ? { verdict } : {}),
      events: [...task.events, event],
    },
  };
}

const MANAGER_RANK: Readonly<Record<TaskStatus, number>> = {
  failed: 0,
  blocked: 1,
  submitted: 2,
  rework: 3,
  doing: 4,
  todo: 5,
  done: 6,
  cancelled: 7,
};

/** 管理者看的顺序：最该处理的在前，同级里更新得早的在前。 */
export function sortForManager(tasks: readonly LedgerTask[]): LedgerTask[] {
  return [...tasks].sort(
    (a, b) => MANAGER_RANK[a.status] - MANAGER_RANK[b.status] || a.updatedAt - b.updatedAt,
  );
}

/**
 * 大任务的状态由子任务汇总（取消的不算）：有失败 → failed，有卡住 → blocked，
 * 全部 done → submitted（交给管理者判定），全部 todo → todo，其余 → doing。没有子任务返回 undefined。
 */
export function rollupParentStatus(children: readonly LedgerTask[]): TaskStatus | undefined {
  const live = children.filter((child) => child.status !== "cancelled");
  if (live.length === 0) {
    return undefined;
  }
  if (live.some((child) => child.status === "failed")) {
    return "failed";
  }
  if (live.some((child) => child.status === "blocked")) {
    return "blocked";
  }
  if (live.every((child) => child.status === "done")) {
    return "submitted";
  }
  if (live.every((child) => child.status === "todo")) {
    return "todo";
  }
  return "doing";
}

function grams(text: string): Set<string> {
  const chars = [...text.toLowerCase()].filter((c) => {
    const k = c.charCodeAt(0);
    return k > 127 || (k >= 48 && k <= 57) || (k >= 97 && k <= 122);
  });
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) {
    out.add((chars[i] ?? "") + (chars[i + 1] ?? ""));
  }
  return out;
}

/** 两段文字共有的相邻两字占较短一段的比例，0 到 1。 */
export function overlapScore(a: string, b: string): number {
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) {
    return 0;
  }
  let hit = 0;
  for (const g of ga) {
    if (gb.has(g)) {
      hit += 1;
    }
  }
  return hit / Math.min(ga.size, gb.size);
}

/** 新建前先看有没有同主题的未完成大任务，有就应该挂成它的子任务。只看顶层任务。 */
export function findOverlapping(
  open: readonly LedgerTask[],
  title: string,
  detail: string,
  threshold = 0.35,
): LedgerTask[] {
  const probe = `${title} ${detail}`;
  return open
    .filter((task) => task.parentId === undefined && isTaskOpen(task.status))
    .map((task) => ({ task, score: overlapScore(probe, `${task.title} ${task.detail}`) }))
    .filter((item) => item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.task);
}
