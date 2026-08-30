/**
 * 任务看板分组（W3.6）：纯逻辑，可单测。
 * §11.4 六列看板不含 cancelled（取消是终态，不占列）；按状态归组保持列表原有顺序。
 */

import type { Task, TaskStatus } from "@ff-pane/shared";

/** 看板列顺序（§11.4，六列，不含 cancelled）。 */
export const BOARD_STATUSES: readonly TaskStatus[] = [
  "pending",
  "running",
  "blocked",
  "failed",
  "done",
  "accepted",
];

/** 按状态归组（返回覆盖全部看板列的记录，空列为 []）。cancelled 任务不入看板。 */
export function groupTasksByStatus(
  tasks: readonly Task[],
): Readonly<Record<TaskStatus, readonly Task[]>> {
  const groups: Record<TaskStatus, Task[]> = {
    pending: [],
    running: [],
    blocked: [],
    failed: [],
    done: [],
    accepted: [],
    cancelled: [],
  };
  for (const task of tasks) {
    groups[task.status].push(task);
  }
  return groups;
}
