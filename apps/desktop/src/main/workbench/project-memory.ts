/**
 * 工作台记忆工具接到现有项目记忆（T10.10）。
 * 真实源仍是 Markdown；检索与写后索引钩子用同一份 MemoryIndexService，不另开一套库。
 */

import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryEntry, MemoryEntryId } from "@ff-pane/shared";
import {
  decodeMemoryEntryFile,
  entryFileName,
  loadEntry,
  type ProjectLayout,
  resolveProjectLayout,
  saveEntry,
} from "@ff-pane/storage";
import type { MemoryIndexService } from "../memory-index";
import { MEMORY_SEARCH_FILE_CAP_NOTE, MEMORY_SEARCH_FILE_MAX_BYTES } from "./memory-policy";

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
    const loaded = await loadEntryForSearch(layout, hit.id);
    if (loaded === undefined) {
      continue;
    }
    // 索引可能还停在旧状态。以文件为准，归档不返回。
    if (loaded.status !== "active" && loaded.status !== "candidate") {
      continue;
    }
    entries.push(loaded);
  }
  return entries;
}

function entryCandidatePaths(layout: ProjectLayout, id: MemoryEntryId): readonly string[] {
  return [
    join(layout.memoryCandidatesDir, entryFileName(id)),
    ...Object.values(layout.memoryCategoryDirs).map((dir) => join(dir, entryFileName(id))),
  ];
}

async function fileByteSize(filePath: string): Promise<number | undefined> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/** 只读开头。文件更短时读完。切断的 UTF-8 尾字节丢掉，避免把替换字符写进正文。 */
async function readUtf8Prefix(filePath: string, maxBytes: number): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const info = await handle.stat();
    const toRead = Math.min(Math.max(0, maxBytes), info.size);
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, 0);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    if (info.size > bytesRead && text.endsWith("\uFFFD")) {
      text = text.slice(0, -1);
    }
    return text;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/**
 * 没有超限副本时整份解码。
 * 任一副本超过上限时不把整份读进内存：只解码开头，并在正文前写明。
 */
async function loadEntryForSearch(
  layout: ProjectLayout,
  id: MemoryEntryId,
): Promise<MemoryEntry | undefined> {
  const existing: Array<{ path: string; size: number }> = [];
  for (const filePath of entryCandidatePaths(layout, id)) {
    const size = await fileByteSize(filePath);
    if (size !== undefined) {
      existing.push({ path: filePath, size });
    }
  }
  if (existing.length === 0) {
    return undefined;
  }
  if (existing.every((file) => file.size <= MEMORY_SEARCH_FILE_MAX_BYTES)) {
    const loaded = await loadEntry(layout, id);
    return loaded.ok ? loaded.value : undefined;
  }
  let best: MemoryEntry | undefined;
  for (const file of existing) {
    const text = await readUtf8Prefix(file.path, MEMORY_SEARCH_FILE_MAX_BYTES);
    if (text === undefined) {
      continue;
    }
    const decoded = decodeMemoryEntryFile(text, file.path);
    if (!decoded.ok || decoded.value.id !== id) {
      continue;
    }
    const entry =
      file.size > MEMORY_SEARCH_FILE_MAX_BYTES
        ? { ...decoded.value, body: `${MEMORY_SEARCH_FILE_CAP_NOTE}\n\n${decoded.value.body}` }
        : decoded.value;
    if (best === undefined || entry.updatedAt > best.updatedAt) {
      best = entry;
    }
  }
  return best;
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
