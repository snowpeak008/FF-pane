/**
 * 记忆页视图逻辑（W3.8）：搜索过滤 + 按类别分组。纯函数，可单测。
 *
 * T8.7 起搜索框走主进程 `memory:search` 混合检索（FTS/LIKE + 向量 → RRF 融合）；
 * 本地子串过滤（matchesMemorySearch）保留为**回退路径**——服务响应未到或检索失败时
 * 用它兜底，搜索框不因嵌入端点抖动而坏掉。
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

/**
 * 用 `memory:search` 的命中 id 列表过滤条目（T8.7）：
 * - `ids === undefined` 表示混合检索结果不可用（无查询 / 在飞 / 失败），
 *   回退本地子串过滤（matchesMemorySearch）——搜索框永远有结果可给；
 * - 命中列表可用时按**命中顺序**返回（RRF 融合排序是检索结果的一部分，
 *   打乱它等于丢掉「语义更相关的排前面」这一信息）。
 */
export function applyMemorySearch(
  entries: readonly MemoryEntry[],
  query: string,
  ids: readonly string[] | undefined,
): readonly MemoryEntry[] {
  if (query.trim().length === 0) {
    return entries;
  }
  if (ids === undefined) {
    return entries.filter((entry) => matchesMemorySearch(entry, query));
  }
  const byId = new Map(entries.map((entry) => [entry.id as string, entry]));
  const matched: MemoryEntry[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry !== undefined) {
      matched.push(entry);
    }
  }
  return matched;
}
