/**
 * 记忆向量索引（T8.7）：复用 knowledge-vector 的双后端实现（表名参数化），
 * 外加记忆特有的「条目嵌入状态」管理。
 *
 * 与知识库的关键差异——**记忆条目是原地可变的**：知识库的检索单元是块，内容变了
 * 走整条替换、rowid 换新，「rowid 有向量」即「向量有效」；记忆条目的 upsert 保持
 * rowid、正文可改，只看向量存在性会让编辑过的条目带着旧语义的向量继续被召回。
 * 故 v3 加一张 memory_embedding_state 存「已嵌入文本的哈希」：
 *
 * - 回填差额 = 「状态行缺席 或 哈希与当前文本不符」的条目（listMemoryRowsForEmbedding）；
 * - 断点续传与「编辑后重嵌入」因此是同一段判定（对应 T6.3 块指纹的条目哈希语义）；
 * - 向量与状态行在同一事务写入（storeMemoryVector）——先写向量后写状态，
 *   中途崩溃只会「算了没记账」（下轮重算，幂等），不会「记了账没向量」。
 *
 * 嵌入文本是 title + body + tags 的规范拼接（与 FTS 参与检索的三列同一口径）：
 * 标题与标签是人工提炼的主题信号，只嵌正文会丢掉「标题一句话概括」这类最浓缩的语义。
 */

import { createHash } from "node:crypto";
import type { MemoryEntryId } from "@ff-pane/shared";
import type Database from "better-sqlite3";
import {
  type EnsureVectorIndexOptions,
  ensureVectorIndex,
  openVectorIndex,
  readVectorState,
  type VectorIndex,
  type VectorIndexResult,
  type VectorTableSpec,
} from "./knowledge-vector.js";
import {
  MEMORY_EMBEDDING_STATE_TABLE,
  MEMORY_VEC0_TABLE,
  MEMORY_VECTOR_FALLBACK_TABLE,
  MEMORY_VECTOR_STATE_TABLE,
} from "./memory-vector-schema.js";
import { MEMORY_CONTENT_TABLE } from "./schema.js";

/** 记忆向量表组（knowledge-vector 各函数的 tables 参数）。 */
export const MEMORY_VECTOR_TABLES: VectorTableSpec = {
  vec0Table: MEMORY_VEC0_TABLE,
  fallbackTable: MEMORY_VECTOR_FALLBACK_TABLE,
  stateTable: MEMORY_VECTOR_STATE_TABLE,
  fallbackOwnerColumn: "entry_rowid",
  fallbackReferences: `${MEMORY_CONTENT_TABLE}(entry_rowid)`,
};

/**
 * 条目的嵌入文本：title + body + tags 以换行拼接（tags 为空则省略该行）。
 * 入参取影子表列（title/body/tags 拼接串）而不是 MemoryEntry——嵌入的必须是
 * 索引里那份文本，两处各拼一遍迟早分叉。
 */
export function memoryEmbeddingText(title: string, body: string, tags: string): string {
  return tags === "" ? `${title}\n${body}` : `${title}\n${body}\n${tags}`;
}

/** 嵌入文本哈希（sha256 hex）。只认文本——模型信息在向量状态表整库唯一，不必进哈希。 */
export function memoryTextHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 读记忆向量状态行（未建过索引则 undefined）。 */
export function readMemoryVectorState(db: Database.Database): ReturnType<typeof readVectorState> {
  return readVectorState(db, MEMORY_VECTOR_TABLES);
}

/** 建立（或复用）记忆向量索引。规格守卫语义同知识库（ensureVectorIndex）。 */
export function ensureMemoryVectorIndex(
  db: Database.Database,
  options: EnsureVectorIndexOptions,
): VectorIndexResult {
  return ensureVectorIndex(db, options, MEMORY_VECTOR_TABLES);
}

/** 打开已有的记忆向量索引（没建过 / 后端不符则 ok:false，走纯 FTS）。 */
export function openMemoryVectorIndex(
  db: Database.Database,
  extensionLoaded: boolean,
): VectorIndexResult {
  return openVectorIndex(db, extensionLoaded, MEMORY_VECTOR_TABLES);
}

/** 丢弃记忆向量索引：向量表、状态行、嵌入状态整体清掉（换模型重建的第一步）。 */
export function dropMemoryVectorIndex(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${MEMORY_VEC0_TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${MEMORY_VECTOR_FALLBACK_TABLE}`);
    db.prepare(`DELETE FROM ${MEMORY_VECTOR_STATE_TABLE}`).run();
    db.prepare(`DELETE FROM ${MEMORY_EMBEDDING_STATE_TABLE}`).run();
  })();
}

/** 一条待嵌入的记忆行（回填差额的工作单元）。 */
export interface MemoryEmbeddingRow {
  /** 影子表 rowid（写向量索引时的键）。 */
  readonly entryRowid: number;
  /** 条目 ID。 */
  readonly id: MemoryEntryId;
  /** 嵌入文本（规范拼接）。 */
  readonly text: string;
  /** 该文本的哈希（嵌入成功后随向量记账）。 */
  readonly textHash: string;
}

/**
 * 找出「还差嵌入」的条目：状态行缺席（从未嵌过）或哈希与当前文本不符（内容改过）。
 * 首次开启嵌入的存量回填、上一轮中途崩掉的续传、编辑后的重嵌入，都是这一个查询。
 */
export function listMemoryRowsForEmbedding(db: Database.Database): readonly MemoryEmbeddingRow[] {
  const rows = db
    .prepare(
      `SELECT e.entry_rowid AS entryRowid, e.id AS id, e.title AS title,
              e.body AS body, e.tags AS tags, s.text_hash AS storedHash
       FROM ${MEMORY_CONTENT_TABLE} e
       LEFT JOIN ${MEMORY_EMBEDDING_STATE_TABLE} s ON s.entry_rowid = e.entry_rowid
       ORDER BY e.entry_rowid`,
    )
    .all() as {
    readonly entryRowid: number;
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly tags: string;
    readonly storedHash: string | null;
  }[];

  const pending: MemoryEmbeddingRow[] = [];
  for (const row of rows) {
    const text = memoryEmbeddingText(row.title, row.body, row.tags);
    const textHash = memoryTextHash(text);
    if (row.storedHash !== textHash) {
      pending.push({ entryRowid: row.entryRowid, id: row.id as MemoryEntryId, text, textHash });
    }
  }
  return pending;
}

/**
 * 落一条向量并记账（单事务）。顺序是「先向量后状态」：中途崩溃只会
 * 「算了没记账」（下轮幂等重算），绝不会出现「记了账没向量」的假完成。
 */
export function storeMemoryVector(
  db: Database.Database,
  index: VectorIndex,
  entryRowid: number,
  vector: readonly number[],
  textHash: string,
): void {
  db.transaction(() => {
    index.put(entryRowid, vector);
    db.prepare(
      `INSERT INTO ${MEMORY_EMBEDDING_STATE_TABLE}(entry_rowid, text_hash) VALUES (?, ?)
       ON CONFLICT(entry_rowid) DO UPDATE SET text_hash = excluded.text_hash`,
    ).run(entryRowid, textHash);
  })();
}

/** 按条目 ID 查影子表 rowid（不存在返回 undefined）。删除钩子清理向量时用。 */
export function findMemoryEntryRowid(db: Database.Database, id: MemoryEntryId): number | undefined {
  const row = db.prepare(`SELECT entry_rowid FROM ${MEMORY_CONTENT_TABLE} WHERE id = ?`).get(id) as
    | { readonly entry_rowid: number }
    | undefined;
  return row?.entry_rowid;
}

/** 已记账（已嵌入且哈希一致概念下）的条目数，供状态展示与测试断言。 */
export function countMemoryEmbeddingState(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${MEMORY_EMBEDDING_STATE_TABLE}`).get() as {
    readonly n: number;
  };
  return row.n;
}
