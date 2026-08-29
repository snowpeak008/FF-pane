/**
 * 项目记忆读写 API（W1.2c）：落位、跨目录寻址、状态流转移动、state 快照。
 * Markdown 文件是唯一真实数据源（设计文档 §8.4），SQLite 索引（W1.3b）从
 * 本层 listEntries 重建。
 *
 * 落位规则（本工单定义，W1.3b 与 UI 依赖此约定）：
 * - status=candidate → memory/candidates/<id>.md（各类别混放，审核通过后归位）；
 * - status=active|archived → 按 category 落 memory/{decisions,rules,lessons}/<id>.md，
 *   archived 用 frontmatter 的 status 区分，不设单独目录；
 * - category=state 不作为条目文件：单文件 memory/state.md 覆盖更新（快照语义、
 *   无状态流转），只走 saveStateSnapshot / loadStateSnapshot，条目 API 对
 *   state 类别抛 MemoryStateCategoryError。
 *
 * 移动与一致性语义：
 * - saveEntry 总是「先原子写规范新址，再清理同 id 其他位置的旧副本」；
 *   updateEntryStatus = 读出 → 改 status 与 updatedAt → saveEntry。
 *   崩溃最坏残留一份旧址副本，不会丢新内容。
 * - 读侧（loadEntry / listEntries）扫描全部条目目录，一律以 frontmatter 字段
 *   为准过滤（目录只是人类可读的组织方式）；同 id 冲突取 updatedAt 较新者，
 *   残留副本因此不产生脏读，并在下一次 saveEntry 时被清理（自愈）。
 * - 读 API 返回 MemoryResult 判别联合；写 API 失败抛异常（沿用 W1.2a 约定）。
 */

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EpochMillis, MemoryEntry, MemoryEntryId, MemoryStatus } from "@ff-pane/shared";
import type { MemoryDirCategory, ProjectLayout } from "../fs/index.js";
import { errnoCodeOf, readText, StorageIoError, writeTextAtomic } from "../fs/index.js";
import {
  decodeIsoTimestamp,
  decodeMemoryEntryFile,
  decodeTitledMarkdownBody,
  encodeIsoTimestamp,
  encodeMemoryEntryFile,
  encodeTitledMarkdownBody,
} from "./entry-file.js";
import type {
  MemoryEntryDecodeError,
  MemoryEntryLoadError,
  MemoryResult,
  MemoryStateSnapshotLoadError,
} from "./errors.js";
import {
  MemoryEncodeError,
  MemoryEntryFieldError,
  MemoryEntryNotFoundError,
  MemoryFrontmatterError,
  MemoryStateCategoryError,
} from "./errors.js";
import { encodeFrontmatterDocument, parseFrontmatterDocument } from "./frontmatter.js";

/** 条目文件名约定：<id>.md。 */
export function entryFileName(id: MemoryEntryId): string {
  return `${id}.md`;
}

/** 全部条目目录（candidates + 三类别目录），loadEntry / listEntries 的扫描范围。 */
function allEntryDirs(layout: ProjectLayout): readonly string[] {
  return [layout.memoryCandidatesDir, ...Object.values(layout.memoryCategoryDirs)];
}

/** id 必须能安全用作文件名：拒绝控制字符、Windows 保留字符与前导点。 */
function isFileNameSafeEntryId(id: string): boolean {
  if (id === "" || id.startsWith(".")) {
    return false;
  }
  for (const ch of id) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || '<>:"/\\|?*'.includes(ch)) {
      return false;
    }
  }
  return true;
}

/** 按落位规则解析条目文件的规范路径。category=state 抛 MemoryStateCategoryError。 */
export function resolveEntryFilePath(
  layout: ProjectLayout,
  entry: Pick<MemoryEntry, "id" | "category" | "status">,
): string {
  if (entry.category === "state") {
    throw new MemoryStateCategoryError(entry.id);
  }
  const dir =
    entry.status === "candidate"
      ? layout.memoryCandidatesDir
      : layout.memoryCategoryDirs[entry.category];
  return join(dir, entryFileName(entry.id));
}

async function removeStaleEntryCopies(
  layout: ProjectLayout,
  id: MemoryEntryId,
  keepPath: string,
): Promise<void> {
  for (const dir of allEntryDirs(layout)) {
    const stalePath = join(dir, entryFileName(id));
    if (stalePath === keepPath) {
      continue;
    }
    try {
      await rm(stalePath, { force: true });
    } catch (error) {
      throw new StorageIoError(stalePath, "清理记忆条目旧址失败", { cause: error });
    }
  }
}

/**
 * 保存条目：按状态/类别自动落位（原子写），随后清理同 id 的其他旧址——
 * 状态或类别变化时等价于「先写新址再删旧址」的移动。返回写入的规范路径。
 */
export async function saveEntry(layout: ProjectLayout, entry: MemoryEntry): Promise<string> {
  if (!isFileNameSafeEntryId(entry.id)) {
    throw new MemoryEncodeError(
      `记忆条目 id 无法用作文件名（不允许控制字符、<>:"/\\|?* 与前导点）: ${entry.id}`,
    );
  }
  const targetPath = resolveEntryFilePath(layout, entry);
  await writeTextAtomic(targetPath, encodeMemoryEntryFile(entry));
  await removeStaleEntryCopies(layout, entry.id, targetPath);
  return targetPath;
}

/**
 * 按 id 跨目录寻址读取条目。文件名必须与 frontmatter id 一致，不一致按
 * invalid-entry 拒读；同 id 多处命中（崩溃残留）取 updatedAt 较新者。
 */
export async function loadEntry(
  layout: ProjectLayout,
  id: MemoryEntryId,
): Promise<MemoryResult<MemoryEntry, MemoryEntryLoadError>> {
  const dirs = allEntryDirs(layout);
  let best: MemoryEntry | undefined;
  for (const dir of dirs) {
    const filePath = join(dir, entryFileName(id));
    const read = await readText(filePath);
    if (!read.ok) {
      if (read.error.code === "not-found") {
        continue;
      }
      return { ok: false, error: read.error };
    }
    const decoded = decodeMemoryEntryFile(read.value, filePath);
    if (!decoded.ok) {
      return decoded;
    }
    if (decoded.value.id !== id) {
      return {
        ok: false,
        error: new MemoryEntryFieldError(
          filePath,
          "id",
          `frontmatter id「${decoded.value.id}」与文件名不一致`,
        ),
      };
    }
    if (best === undefined || decoded.value.updatedAt > best.updatedAt) {
      best = decoded.value;
    }
  }
  if (best === undefined) {
    return { ok: false, error: new MemoryEntryNotFoundError(id, dirs) };
  }
  return { ok: true, value: best };
}

/**
 * 状态流转：改写 status 与 updatedAt 后按新落位保存（先写新址再删旧址）。
 * 只做机械移动，不校验流转方向（candidate→active 等业务规则归 core 层）。
 */
export async function updateEntryStatus(
  layout: ProjectLayout,
  id: MemoryEntryId,
  status: MemoryStatus,
  updatedAt: EpochMillis = Date.now(),
): Promise<MemoryResult<MemoryEntry, MemoryEntryLoadError>> {
  const loaded = await loadEntry(layout, id);
  if (!loaded.ok) {
    return loaded;
  }
  const updated: MemoryEntry = { ...loaded.value, status, updatedAt };
  await saveEntry(layout, updated);
  return { ok: true, value: updated };
}

/** listEntries 的过滤条件（state 是快照不是条目，故类别取 MemoryDirCategory）。 */
export interface ListEntriesFilter {
  readonly category?: MemoryDirCategory;
  readonly status?: MemoryStatus;
}

/** 扫描中被跳过的问题文件：路径 + typed error，供调用方上报（不阻断列表）。 */
export interface MemoryEntryIssue {
  readonly path: string;
  readonly error: MemoryEntryDecodeError | StorageIoError;
}

/** listEntries 的结果：合法条目 + 问题文件清单。 */
export interface ListEntriesResult {
  readonly entries: readonly MemoryEntry[];
  readonly issues: readonly MemoryEntryIssue[];
}

function compareForListing(a: MemoryEntry, b: MemoryEntry): number {
  if (a.updatedAt !== b.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  if (a.id < b.id) {
    return -1;
  }
  return a.id > b.id ? 1 : 0;
}

/**
 * 列出条目：扫描全部条目目录，按 frontmatter 字段过滤（archived 靠 status
 * 字段区分）。损坏 / 非法文件不阻断列表，进 issues。排序：updatedAt 降序，
 * 同刻按 id 升序（与 §8.1 注入截断的「更新时间」口径一致）。
 */
export async function listEntries(
  layout: ProjectLayout,
  filter: ListEntriesFilter = {},
): Promise<ListEntriesResult> {
  const byId = new Map<string, MemoryEntry>();
  const issues: MemoryEntryIssue[] = [];

  for (const dir of allEntryDirs(layout)) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errnoCodeOf(error) === "ENOENT") {
        continue;
      }
      issues.push({
        path: dir,
        error: new StorageIoError(dir, "读取记忆目录失败", { cause: error }),
      });
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md") || name.startsWith(".")) {
        continue;
      }
      const filePath = join(dir, name);
      const read = await readText(filePath);
      if (!read.ok) {
        if (read.error.code !== "not-found") {
          issues.push({ path: filePath, error: read.error });
        }
        continue;
      }
      const decoded = decodeMemoryEntryFile(read.value, filePath);
      if (!decoded.ok) {
        issues.push({ path: filePath, error: decoded.error });
        continue;
      }
      const entry = decoded.value;
      if (entryFileName(entry.id) !== name) {
        issues.push({
          path: filePath,
          error: new MemoryEntryFieldError(
            filePath,
            "id",
            `frontmatter id「${entry.id}」与文件名不一致`,
          ),
        });
        continue;
      }
      const existing = byId.get(entry.id);
      if (existing === undefined || entry.updatedAt > existing.updatedAt) {
        byId.set(entry.id, entry);
      }
    }
  }

  const entries = [...byId.values()]
    .filter(
      (entry) =>
        (filter.category === undefined || entry.category === filter.category) &&
        (filter.status === undefined || entry.status === filter.status),
    )
    .sort(compareForListing);
  return { entries, issues };
}

/**
 * state 快照（§8.1 category=state 的特殊形态）：单文件 memory/state.md，
 * 每次保存整体覆盖，无 id / status / source——frontmatter 只有 updated 一个 key。
 */
export interface MemoryStateSnapshot {
  /** 一句话标题（如「当前状态」），正文首行一级标题。 */
  readonly title: string;
  /** 快照正文（Markdown），允许为空。 */
  readonly body: string;
  /** 快照时间（epoch 毫秒）。 */
  readonly updatedAt: EpochMillis;
}

/** 覆盖写入 state 快照（原子写，快照语义：整文件替换）。 */
export async function saveStateSnapshot(
  layout: ProjectLayout,
  snapshot: MemoryStateSnapshot,
): Promise<void> {
  const text = encodeFrontmatterDocument({
    frontmatter: { updated: encodeIsoTimestamp(snapshot.updatedAt) },
    body: encodeTitledMarkdownBody(snapshot.title, snapshot.body),
  });
  await writeTextAtomic(layout.memoryStateFile, text);
}

/** 读取 state 快照。文件不存在（尚未生成过快照）是常态分支。 */
export async function loadStateSnapshot(
  layout: ProjectLayout,
): Promise<MemoryResult<MemoryStateSnapshot, MemoryStateSnapshotLoadError>> {
  const filePath = layout.memoryStateFile;
  const read = await readText(filePath);
  if (!read.ok) {
    return read;
  }
  const parsed = parseFrontmatterDocument(read.value);
  if (!parsed.ok) {
    return {
      ok: false,
      error: new MemoryFrontmatterError(filePath, parsed.issue.line, parsed.issue.reason),
    };
  }
  const updatedAt = decodeIsoTimestamp(parsed.value.frontmatter["updated"]);
  if (updatedAt === undefined) {
    return {
      ok: false,
      error: new MemoryEntryFieldError(filePath, "updated", "缺失或非法的 ISO 8601 时间字符串"),
    };
  }
  const titled = decodeTitledMarkdownBody(parsed.value.body);
  if (!titled.ok) {
    return { ok: false, error: new MemoryEntryFieldError(filePath, "title", titled.reason) };
  }
  return { ok: true, value: { title: titled.title, body: titled.body, updatedAt } };
}
