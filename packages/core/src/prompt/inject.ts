/**
 * Prompt 第 3 层：项目记忆注入（设计文档 §8.1 注入策略）。
 *
 * 按角色选条 + 条数上限截断，避免上下文膨胀：
 * - Planner：全部 active 的 decision + rule（state 快照单独作为一项，见 assemble）；
 * - Worker：任务合同 context_refs 指定的条目（Planner 拆任务时挑选）；
 * - Reviewer：相关 rule（验收标准属第 4 层任务合同）。
 * 上限默认 20，超出按「类别优先级 + 更新时间」截断。
 */

import type { MemoryCategory, MemoryEntry, Role, TaskContract } from "@ff-pane/shared";

/** 注入条数上限缺省值（§8.1）。 */
export const DEFAULT_INJECTION_LIMIT = 20;

/** 截断排序的类别优先级（值小者先保留）。 */
const CATEGORY_PRIORITY: Readonly<Record<MemoryCategory, number>> = {
  decision: 0,
  rule: 1,
  state: 2,
  lesson: 3,
};

/** 按角色策略从 active 记忆中选条（不截断）。 */
export function selectMemoryForRole(
  role: Role,
  memory: readonly MemoryEntry[],
  task?: TaskContract,
): readonly MemoryEntry[] {
  const active = memory.filter((entry) => entry.status === "active");
  switch (role) {
    case "planner":
      return active.filter((e) => e.category === "decision" || e.category === "rule");
    case "worker": {
      const refs = new Set<string>(task?.contextRefs ?? []);
      return active.filter((e) => refs.has(e.id));
    }
    case "reviewer":
      return active.filter((e) => e.category === "rule");
  }
}

/**
 * 按「类别优先级 + 更新时间倒序」截断到 limit 条（§8.1）。
 * 稳定：同优先级同更新时间按 id 升序，保证组装结果可快照。
 */
export function truncateByPriority(
  entries: readonly MemoryEntry[],
  limit: number,
): readonly MemoryEntry[] {
  return [...entries]
    .sort((a, b) => {
      const byCategory = CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
      if (byCategory !== 0) {
        return byCategory;
      }
      if (a.updatedAt !== b.updatedAt) {
        return b.updatedAt - a.updatedAt;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, Math.max(0, limit));
}

/** 单条记忆渲染为一行（进 Prompt）。 */
export function renderMemoryEntry(entry: MemoryEntry): string {
  return `- [${entry.category}] ${entry.title}：${entry.body}`;
}
