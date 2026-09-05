/**
 * 记忆索引同步钩子(W1.3b):把 W1.3a 的索引原语包装成与 memory store(W1.2c)
 * 写 API 一一对应的业务钩子,并提供从真实源全量重建的入口。
 *
 * 调用顺序(宿主责任):Markdown 是唯一真实数据源,索引是派生数据(设计文档 §8.4),
 * 因此一律「先写真实源成功、再调对应钩子」——真实源写失败时不产生索引变更;
 * 钩子失败时索引落后于真实源,由 rebuildIndexFromStore 自愈。反过来先写索引则
 * 会留下无对应文件的幽灵命中,无法自愈。
 *
 * state 快照(memory/state.md)没有 id / status,不是条目,故没有对应钩子,
 * 也不参与索引(设计文档 §8.1);saveStateSnapshot / loadStateSnapshot 无需同步。
 */

import type { MemoryEntry, MemoryEntryId } from "@ff-pane/shared";
import type Database from "better-sqlite3";
import type { ProjectLayout } from "../fs/index.js";
import type { MemoryEntryIssue } from "../memory/index.js";
import { listEntries } from "../memory/index.js";
import type { VectorIndex } from "./knowledge-vector.js";
import { deleteMemoryEntry, rebuildIndex, upsertMemoryEntry } from "./memory-index.js";
import { MEMORY_CONTENT_TABLE } from "./schema.js";

/**
 * 条目新建 / 内容改写后的钩子(对齐 saveEntry):整行写入索引,已存在即覆盖。
 * T8.7 起可传向量索引:内容变了即作废旧向量(见 upsertMemoryEntry),
 * 新向量由宿主的回填编排补齐——钩子只管索引一致性,不发嵌入请求。
 */
export function syncEntrySaved(
  db: Database.Database,
  entry: MemoryEntry,
  vectorIndex?: VectorIndex,
): void {
  upsertMemoryEntry(db, entry, vectorIndex);
}

/**
 * 条目状态流转后的钩子(对齐 updateEntryStatus,传入其返回的更新后条目)。
 * status 只是索引行的一列,故与 syncEntrySaved 同为整行覆盖;保留独立命名是为了
 * 让每个 store 写入口都有名字对得上的钩子,漏挂钩子时一眼可查。
 * (状态不进嵌入文本,故状态流转不会触发向量作废——哈希不变。)
 */
export function syncEntryStatusChanged(
  db: Database.Database,
  entry: MemoryEntry,
  vectorIndex?: VectorIndex,
): void {
  syncEntrySaved(db, entry, vectorIndex);
}

/** 条目删除后的钩子:移除索引行与向量。索引中不存在该 id 时静默(与删除语义一致,幂等)。 */
export function syncEntryDeleted(
  db: Database.Database,
  id: MemoryEntryId,
  vectorIndex?: VectorIndex,
): void {
  deleteMemoryEntry(db, id, vectorIndex);
}

/** rebuildIndexFromStore 的结果。 */
export interface RebuildIndexFromStoreResult {
  /** 灌入索引的条目数(= listEntries 返回的合法条目数)。 */
  readonly indexed: number;
  /**
   * 扫描中被跳过的损坏 / 非法文件,原样来自 listEntries。
   * 调用方须上报(重建"成功"但静默丢条目,等于让用户丢记忆而不知情)。
   */
  readonly issues: readonly MemoryEntryIssue[];
}

/**
 * 从 Markdown 真实源全量重建记忆索引:listEntries 扫全部条目目录后单事务重灌
 * (中途失败回滚到旧索引)。删库重开、索引疑似落后、批量外部编辑后的兜底入口。
 * 有向量索引时须传入——重建后 rowid 整体换新,旧向量必须一并清空(见 rebuildIndex)。
 */
export async function rebuildIndexFromStore(
  layout: ProjectLayout,
  db: Database.Database,
  vectorIndex?: VectorIndex,
): Promise<RebuildIndexFromStoreResult> {
  const { entries, issues } = await listEntries(layout);
  return { indexed: rebuildIndex(db, entries, vectorIndex), issues };
}

/**
 * 从真实源**对账**（T8.7）：逐条 upsert + 出清真实源已不存在的行，
 * 与 rebuildIndexFromStore 的差别是**保持既有行的 rowid 稳定**。
 *
 * rebuild 的「清空重灌」会让全部 rowid 换新、连带全部向量作废重算——对每次启动
 * 都要保证索引不落后的宿主来说，这等于每次启动都把嵌入的钱重花一遍。对账则只让
 * 「内容真变了」的条目作废向量（upsertMemoryEntry 的哈希判定），未变条目的向量
 * 原样保留。rebuild 保留给「索引疑似损坏」的兜底场景。
 */
export async function reconcileIndexFromStore(
  layout: ProjectLayout,
  db: Database.Database,
  vectorIndex?: VectorIndex,
): Promise<RebuildIndexFromStoreResult> {
  const { entries, issues } = await listEntries(layout);
  const alive = new Set<string>(entries.map((entry) => entry.id));
  const indexedIds = (
    db.prepare(`SELECT id FROM ${MEMORY_CONTENT_TABLE}`).all() as { readonly id: string }[]
  ).map((row) => row.id);

  db.transaction(() => {
    for (const id of indexedIds) {
      if (!alive.has(id)) {
        deleteMemoryEntry(db, id as MemoryEntryId, vectorIndex);
      }
    }
    for (const entry of entries) {
      upsertMemoryEntry(db, entry, vectorIndex);
    }
  })();
  return { indexed: entries.length, issues };
}
