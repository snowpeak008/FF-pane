/**
 * 习惯档案视图逻辑（T5.1）：按类别分组、搜索过滤、规模阈值。纯函数，可单测。
 * 设计文档 §8.2：习惯是小而精的短文本集合，全量注入，上限默认 80（§8.2.5）。
 */

import type { HabitEntry } from "@ff-pane/shared";
import { HABIT_CATEGORIES, HABIT_ENTRY_SOFT_LIMIT, type HabitCategory } from "@ff-pane/shared";

/** 分组展示的类别顺序（§8.2.1 四类，workflow 先行——它是流程约束）。 */
export const HABIT_CATEGORY_ORDER: readonly HabitCategory[] = HABIT_CATEGORIES;

/** 接近上限的提示阈值：达到软上限的 90% 即提示合并 / 归档（§8.2.5，不自动淘汰）。 */
export const HABIT_SOFT_LIMIT_WARN_AT = Math.floor(HABIT_ENTRY_SOFT_LIMIT * 0.9);

/** 条目是否命中搜索（content，大小写不敏感）。空查询恒命中。 */
export function matchesHabitSearch(entry: HabitEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q.length === 0 || entry.content.toLowerCase().includes(q);
}

/** 按类别分组（返回覆盖全部类别的记录，空类别为 []）。入参应已按需过滤 / 排序。 */
export function groupHabitsByCategory(
  entries: readonly HabitEntry[],
): Readonly<Record<HabitCategory, readonly HabitEntry[]>> {
  const groups: Record<HabitCategory, HabitEntry[]> = {
    workflow: [],
    tech: [],
    communication: [],
    environment: [],
  };
  for (const entry of entries) {
    groups[entry.category].push(entry);
  }
  return groups;
}

/** 组内排序：重要度降序，同值按更新时间降序（与 T5.2 编译排序口径一致）。 */
export function sortHabitsForDisplay(entries: readonly HabitEntry[]): readonly HabitEntry[] {
  return [...entries].sort((a, b) => {
    if (b.importance !== a.importance) {
      return b.importance - a.importance;
    }
    return b.updatedAt - a.updatedAt;
  });
}
