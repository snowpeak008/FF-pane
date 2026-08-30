/**
 * 记忆页视图逻辑（W3.8）：搜索过滤 + 按类别分组。纯函数，可单测。
 * 全文检索的 FTS（万级条目，index-db）留后续；Phase 3 先用标题/正文子串过滤，
 * 单项目条目量有限，够用。
 */

import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryEntry } from "@ff-pane/shared";

/** 分组展示的类别顺序（§8.1 四类）。 */
export const MEMORY_CATEGORY_ORDER: readonly MemoryCategory[] = MEMORY_CATEGORIES;

/** 条目是否命中搜索（标题 / 正文 / 标签，大小写不敏感）。空查询恒命中。 */
export function matchesMemorySearch(entry: MemoryEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return true;
  }
  if (entry.title.toLowerCase().includes(q) || entry.body.toLowerCase().includes(q)) {
    return true;
  }
  return (entry.tags ?? []).some((tag) => tag.toLowerCase().includes(q));
}

/** 按类别分组（返回覆盖全部类别的记录，空类别为 []）。入参应已按需过滤/排序。 */
export function groupByCategory(
  entries: readonly MemoryEntry[],
): Readonly<Record<MemoryCategory, readonly MemoryEntry[]>> {
  const groups: Record<MemoryCategory, MemoryEntry[]> = {
    decision: [],
    rule: [],
    lesson: [],
    state: [],
  };
  for (const entry of entries) {
    groups[entry.category].push(entry);
  }
  return groups;
}
