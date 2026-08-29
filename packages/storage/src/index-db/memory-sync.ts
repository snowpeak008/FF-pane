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
import { deleteMemoryEntry, rebuildIndex, upsertMemoryEntry } from "./memory-index.js";

/** 条目新建 / 内容改写后的钩子(对齐 saveEntry):整行写入索引,已存在即覆盖。 */
export function syncEntrySaved(db: Database.Database, entry: MemoryEntry): void {
  upsertMemoryEntry(db, entry);
}

/**
 * 条目状态流转后的钩子(对齐 updateEntryStatus,传入其返回的更新后条目)。
 * status 只是索引行的一列,故与 syncEntrySaved 同为整行覆盖;保留独立命名是为了
 * 让每个 store 写入口都有名字对得上的钩子,漏挂钩子时一眼可查。
 */
export function syncEntryStatusChanged(db: Database.Database, entry: MemoryEntry): void {
  syncEntrySaved(db, entry);
}

/** 条目删除后的钩子:移除索引行。索引中不存在该 id 时静默(与删除语义一致,幂等)。 */
export function syncEntryDeleted(db: Database.Database, id: MemoryEntryId): void {
  deleteMemoryEntry(db, id);
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
 */
export async function rebuildIndexFromStore(
  layout: ProjectLayout,
  db: Database.Database,
): Promise<RebuildIndexFromStoreResult> {
  const { entries, issues } = await listEntries(layout);
  return { indexed: rebuildIndex(db, entries), issues };
}
