/**
 * 工作台记忆工具接到现有项目记忆（T10.10）。
 * 真实源仍是 Markdown；检索与写后索引钩子用同一份 MemoryIndexService，不另开一套库。
 */

import type { MemoryEntry, MemoryEntryId } from "@ff-pane/shared";
import { loadEntry, resolveProjectLayout, saveEntry } from "@ff-pane/storage";
import type { MemoryIndexService } from "../memory-index";

/** 检索只看本项目的已生效条目和待审核候选。归档不进窗口上下文。 */
const SEARCH_STATUSES = ["active", "candidate"] as const;

export async function searchCallerProjectMemory(
  index: MemoryIndexService,
  projectRoot: string,
  query: string,
  limit: number,
): Promise<readonly MemoryEntry[]> {
  const response = await index.search({
    projectRoot,
    query,
    limit,
    statuses: [...SEARCH_STATUSES],
  });
  const layout = resolveProjectLayout(projectRoot);
  const entries: MemoryEntry[] = [];
  for (const hit of response.hits) {
    const loaded = await loadEntry(layout, hit.id);
    if (!loaded.ok) {
      continue;
    }
    // 索引可能还停在旧状态。以文件为准，归档不返回。
    if (loaded.value.status !== "active" && loaded.value.status !== "candidate") {
      continue;
    }
    entries.push(loaded.value);
  }
  return entries;
}

/** 先写 Markdown，再通知已打开的索引。索引还没打开时，下次检索的对账会把这条捡起来。 */
export async function addCallerProjectMemory(
  index: MemoryIndexService,
  projectRoot: string,
  entry: MemoryEntry,
): Promise<MemoryEntryId> {
  const layout = resolveProjectLayout(projectRoot);
  await saveEntry(layout, entry);
  await index.entrySaved(projectRoot, entry);
  return entry.id;
}
