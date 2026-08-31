/**
 * 知识库索引写入原语（T6.4）：条目 / 块 / 标签的落库与删除。
 *
 * 与 v1 记忆索引同一分工：本层只碰派生索引，不读写原文件（§8.4 真实源是原文件）。
 * 导入编排（解析 → 分块 → 索引 → 嵌入）归 T6.5，本层只提供它需要的原子操作。
 *
 * 两处值得说明的决定：
 *
 * - **条目落库是「整条替换」而不是增量 patch**：一份文档重新索引时，块的数量与
 *   边界都可能变（改了一段话，后面所有块的 seq 全变）。逐块 diff 既复杂又容易
 *   留下孤块，不如整条重来——单事务内先删旧块再灌新块，外部看是原子的。
 *
 * - **增量索引的判断在 upsert 之前，不在里面**：`findEntryByContentHash` 给出
 *   「这份内容是否已索引」的事实，要不要跳过由导入编排决定（§8.3.2「按内容哈希
 *   判断变化，只重新索引变动的文件」）。把跳过逻辑埋进 upsert 会让「强制重建」
 *   这种正当需求无处落脚。
 */

import type {
  ChunkProvenance,
  KnowledgeChunk,
  KnowledgeChunkId,
  KnowledgeEntry,
  KnowledgeEntryId,
  KnowledgeFormat,
  KnowledgeOrigin,
  LocalSessionId,
} from "@ff-pane/shared";
import type Database from "better-sqlite3";
import { toPosixPath } from "../index.js";
import {
  KNOWLEDGE_CHUNK_TABLE,
  KNOWLEDGE_ENTRY_TABLE,
  KNOWLEDGE_TAG_TABLE,
} from "./knowledge-schema.js";
import type { VectorIndex } from "./knowledge-vector.js";

/** 条目行（含 rowid，供块与标签挂接）。 */
export interface KnowledgeEntryRow {
  /** 条目 rowid（内部主键）。 */
  readonly entryRowid: number;
  /** 条目领域实体。 */
  readonly entry: KnowledgeEntry;
}

/** DB 行 → KnowledgeOrigin。三种来源在同一张表上用两列表达，读回时收窄。 */
function toOrigin(
  kind: string,
  originPath: string | null,
  sessionId: string | null,
): KnowledgeOrigin {
  switch (kind) {
    case "file_import":
      return { kind: "file_import", sourcePath: originPath ?? "" };
    case "session_capture":
      return { kind: "session_capture", sessionId: (sessionId ?? "") as LocalSessionId };
    default:
      return { kind: "manual" };
  }
}

/** KnowledgeOrigin → 两列。file_import 的路径统一为正斜杠，前缀过滤才对得上。 */
function fromOrigin(origin: KnowledgeOrigin): {
  readonly kind: string;
  readonly path: string | null;
  readonly sessionId: string | null;
} {
  switch (origin.kind) {
    case "file_import":
      return { kind: origin.kind, path: toPosixPath(origin.sourcePath), sessionId: null };
    case "session_capture":
      return { kind: origin.kind, path: null, sessionId: origin.sessionId };
    default:
      return { kind: origin.kind, path: null, sessionId: null };
  }
}

/** 条目表的一行原始形态。 */
interface EntryDbRow {
  readonly entry_rowid: number;
  readonly id: string;
  readonly title: string;
  readonly format: KnowledgeFormat;
  readonly origin_kind: string;
  readonly origin_path: string | null;
  readonly origin_session_id: string | null;
  readonly content_hash: string;
  readonly imported_at: number;
}

/** 把条目行与它的标签拼成领域实体。 */
function toEntry(row: EntryDbRow, tags: readonly string[]): KnowledgeEntry {
  // exactOptionalPropertyTypes 全开：可选字段用条件展开，不写 undefined
  return {
    id: row.id as KnowledgeEntryId,
    title: row.title,
    format: row.format,
    origin: toOrigin(row.origin_kind, row.origin_path, row.origin_session_id),
    contentHash: row.content_hash,
    importedAt: row.imported_at,
    ...(tags.length === 0 ? {} : { tags }),
  };
}

/**
 * 读回条目标签。**按字典序返回，不保留写入顺序**——标签是集合，顺序不承载信息，
 * 而确定性顺序能让「读回来的条目」在任何时候都完全相同（写入顺序不同的同一组标签
 * 不该被判成两份不同的条目）。
 */
function readTags(db: Database.Database, entryRowid: number): string[] {
  const rows = db
    .prepare(`SELECT tag FROM ${KNOWLEDGE_TAG_TABLE} WHERE entry_rowid = ? ORDER BY tag`)
    .all(entryRowid) as { readonly tag: string }[];
  return rows.map((row) => row.tag);
}

/** 块的出处 → 存储列。headingPath 存 JSON 数组原文（也是 FTS heading 列的内容）。 */
function fromProvenance(provenance: ChunkProvenance): {
  readonly filePath: string;
  readonly headingPath: string | null;
  readonly page: number | null;
} {
  return {
    filePath: toPosixPath(provenance.filePath),
    headingPath:
      provenance.headingPath === undefined || provenance.headingPath.length === 0
        ? null
        : JSON.stringify(provenance.headingPath),
    page: provenance.page ?? null,
  };
}

/** 存储列 → 块的出处。headingPath 解析失败视为无标题路径，不让一行坏数据毁掉整次检索。 */
export function toProvenance(
  filePath: string,
  headingPath: string | null,
  page: number | null,
): ChunkProvenance {
  let parsed: readonly string[] | undefined;
  if (headingPath !== null && headingPath !== "") {
    try {
      const value: unknown = JSON.parse(headingPath);
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        parsed = value;
      }
    } catch {
      parsed = undefined;
    }
  }
  return {
    filePath,
    ...(parsed === undefined || parsed.length === 0 ? {} : { headingPath: parsed }),
    ...(page === null ? {} : { page }),
  };
}

/** 块表的一行原始形态。 */
export interface ChunkDbRow {
  readonly chunk_rowid: number;
  readonly id: string;
  readonly entry_id: string;
  readonly seq: number;
  readonly text: string;
  readonly file_path: string;
  readonly heading_path: string | null;
  readonly page: number | null;
}

/** 块行 → 领域实体。 */
export function toKnowledgeChunk(row: ChunkDbRow): KnowledgeChunk {
  return {
    id: row.id as KnowledgeChunkId,
    entryId: row.entry_id as KnowledgeEntryId,
    seq: row.seq,
    text: row.text,
    provenance: toProvenance(row.file_path, row.heading_path, row.page),
  };
}

/** 块行的公共 SELECT 列（各处查询共用，避免列名在多处漂移）。 */
export const CHUNK_SELECT_COLUMNS = `
  ${KNOWLEDGE_CHUNK_TABLE}.chunk_rowid AS chunk_rowid,
  ${KNOWLEDGE_CHUNK_TABLE}.id AS id,
  ${KNOWLEDGE_ENTRY_TABLE}.id AS entry_id,
  ${KNOWLEDGE_CHUNK_TABLE}.seq AS seq,
  ${KNOWLEDGE_CHUNK_TABLE}.text AS text,
  ${KNOWLEDGE_CHUNK_TABLE}.file_path AS file_path,
  ${KNOWLEDGE_CHUNK_TABLE}.heading_path AS heading_path,
  ${KNOWLEDGE_CHUNK_TABLE}.page AS page
`;

/** 按条目 ID 查 rowid（不存在返回 undefined）。 */
export function findEntryRowid(
  db: Database.Database,
  entryId: KnowledgeEntryId,
): number | undefined {
  const row = db
    .prepare(`SELECT entry_rowid FROM ${KNOWLEDGE_ENTRY_TABLE} WHERE id = ?`)
    .get(entryId) as { readonly entry_rowid: number } | undefined;
  return row?.entry_rowid;
}

/** 按条目 ID 读回条目（含标签）。 */
export function getKnowledgeEntry(
  db: Database.Database,
  entryId: KnowledgeEntryId,
): KnowledgeEntry | undefined {
  const row = db.prepare(`SELECT * FROM ${KNOWLEDGE_ENTRY_TABLE} WHERE id = ?`).get(entryId) as
    | EntryDbRow
    | undefined;
  return row === undefined ? undefined : toEntry(row, readTags(db, row.entry_rowid));
}

/**
 * 按内容哈希找条目（§8.3.2 增量索引的判断依据）。
 * 命中即说明「这份内容已经索引过」，导入编排据此跳过重新解析与嵌入。
 */
export function findEntryByContentHash(
  db: Database.Database,
  contentHash: string,
): KnowledgeEntry | undefined {
  const row = db
    .prepare(`SELECT * FROM ${KNOWLEDGE_ENTRY_TABLE} WHERE content_hash = ? ORDER BY entry_rowid`)
    .get(contentHash) as EntryDbRow | undefined;
  return row === undefined ? undefined : toEntry(row, readTags(db, row.entry_rowid));
}

/** 写入或覆盖一个条目（不动它的块）。返回 rowid。 */
export function upsertKnowledgeEntry(db: Database.Database, entry: KnowledgeEntry): number {
  const origin = fromOrigin(entry.origin);
  const run = db.transaction((): number => {
    db.prepare(
      `INSERT INTO ${KNOWLEDGE_ENTRY_TABLE}
         (id, title, format, origin_kind, origin_path, origin_session_id, content_hash, imported_at)
       VALUES (@id, @title, @format, @originKind, @originPath, @originSessionId, @contentHash, @importedAt)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         format = excluded.format,
         origin_kind = excluded.origin_kind,
         origin_path = excluded.origin_path,
         origin_session_id = excluded.origin_session_id,
         content_hash = excluded.content_hash,
         imported_at = excluded.imported_at`,
    ).run({
      id: entry.id,
      title: entry.title,
      format: entry.format,
      originKind: origin.kind,
      originPath: origin.path,
      originSessionId: origin.sessionId,
      contentHash: entry.contentHash,
      importedAt: entry.importedAt,
    });

    const entryRowid = findEntryRowid(db, entry.id);
    if (entryRowid === undefined) {
      throw new Error(`条目 ${entry.id} 写入后仍查不到 rowid，索引已损坏`);
    }
    // 标签整体替换：改标签是「这条现在有哪些标签」的声明，不是增量追加
    db.prepare(`DELETE FROM ${KNOWLEDGE_TAG_TABLE} WHERE entry_rowid = ?`).run(entryRowid);
    const insertTag = db.prepare(
      `INSERT OR IGNORE INTO ${KNOWLEDGE_TAG_TABLE}(entry_rowid, tag) VALUES (?, ?)`,
    );
    for (const tag of entry.tags ?? []) {
      const trimmed = tag.trim();
      if (trimmed !== "") {
        insertTag.run(entryRowid, trimmed);
      }
    }
    return entryRowid;
  });
  return run();
}

/** 一个块的落库形态（seq / 正文 / 出处 + 调用方给定的块 ID）。 */
export interface KnowledgeChunkInput {
  /** 块 ID（由收录流程生成，见 rag 的 toKnowledgeChunks）。 */
  readonly id: KnowledgeChunkId;
  /** 块在条目内的序号，从 0 起。 */
  readonly seq: number;
  /** 块正文。 */
  readonly text: string;
  /** 出处。 */
  readonly provenance: ChunkProvenance;
}

/** 块落库后的 rowid 映射（供嵌入阶段按块写向量）。 */
export interface ChunkRowidMapping {
  /** 块 ID。 */
  readonly chunkId: KnowledgeChunkId;
  /** 块 rowid（写向量索引时的键）。 */
  readonly chunkRowid: number;
  /** 块序号。 */
  readonly seq: number;
}

/**
 * 用一组新块整体替换某条目的全部块（单事务）。
 * 旧块的向量一并删除——留着就是指向已不存在的块的孤儿，会在检索时命中空气。
 * 返回新块的 rowid 映射，供嵌入阶段写向量。
 */
export function replaceEntryChunks(
  db: Database.Database,
  entryId: KnowledgeEntryId,
  chunks: readonly KnowledgeChunkInput[],
  vectorIndex?: VectorIndex,
): readonly ChunkRowidMapping[] {
  const run = db.transaction((): ChunkRowidMapping[] => {
    const entryRowid = findEntryRowid(db, entryId);
    if (entryRowid === undefined) {
      throw new Error(`条目 ${entryId} 不存在，无法写入块`);
    }

    const staleRowids = (
      db
        .prepare(`SELECT chunk_rowid FROM ${KNOWLEDGE_CHUNK_TABLE} WHERE entry_rowid = ?`)
        .all(entryRowid) as { readonly chunk_rowid: number }[]
    ).map((row) => row.chunk_rowid);
    if (staleRowids.length > 0) {
      // vec0 是虚表，外键 CASCADE 管不到它，必须显式删
      vectorIndex?.deleteMany(staleRowids);
      db.prepare(`DELETE FROM ${KNOWLEDGE_CHUNK_TABLE} WHERE entry_rowid = ?`).run(entryRowid);
    }

    const insert = db.prepare(
      `INSERT INTO ${KNOWLEDGE_CHUNK_TABLE}
         (id, entry_rowid, seq, text, file_path, heading_path, page)
       VALUES (@id, @entryRowid, @seq, @text, @filePath, @headingPath, @page)`,
    );
    const mappings: ChunkRowidMapping[] = [];
    for (const chunk of chunks) {
      const provenance = fromProvenance(chunk.provenance);
      const info = insert.run({
        id: chunk.id,
        entryRowid,
        seq: chunk.seq,
        text: chunk.text,
        filePath: provenance.filePath,
        headingPath: provenance.headingPath,
        page: provenance.page,
      });
      mappings.push({
        chunkId: chunk.id,
        chunkRowid: Number(info.lastInsertRowid),
        seq: chunk.seq,
      });
    }
    return mappings;
  });
  return run();
}

/**
 * 删除一个条目及其全部块（外键 CASCADE）与向量。
 * 条目不存在时静默——删除语义天然幂等。返回是否真的删掉了东西。
 */
export function deleteKnowledgeEntry(
  db: Database.Database,
  entryId: KnowledgeEntryId,
  vectorIndex?: VectorIndex,
): boolean {
  const run = db.transaction((): boolean => {
    const entryRowid = findEntryRowid(db, entryId);
    if (entryRowid === undefined) {
      return false;
    }
    const rowids = (
      db
        .prepare(`SELECT chunk_rowid FROM ${KNOWLEDGE_CHUNK_TABLE} WHERE entry_rowid = ?`)
        .all(entryRowid) as { readonly chunk_rowid: number }[]
    ).map((row) => row.chunk_rowid);
    vectorIndex?.deleteMany(rowids);
    db.prepare(`DELETE FROM ${KNOWLEDGE_ENTRY_TABLE} WHERE entry_rowid = ?`).run(entryRowid);
    return true;
  });
  return run();
}

/** 来源统计（§8.3.6 来源管理：文档数 / 块数 / 索引状态）。 */
export interface KnowledgeStats {
  /** 条目数。 */
  readonly entries: number;
  /** 块数。 */
  readonly chunks: number;
  /** 已有向量的块数（未建向量索引时为 0）。 */
  readonly vectors: number;
  /** 向量后端；未建向量索引时 undefined。 */
  readonly vectorBackend?: string;
  /** 向量维度；未建向量索引时 undefined。 */
  readonly vectorDimensions?: number;
  /** 嵌入模型；未建向量索引时 undefined。 */
  readonly vectorModel?: string;
}

/** 统计知识库规模与向量覆盖情况。 */
export function getKnowledgeStats(
  db: Database.Database,
  vectorIndex?: VectorIndex,
): KnowledgeStats {
  const entries = (
    db.prepare(`SELECT COUNT(*) AS n FROM ${KNOWLEDGE_ENTRY_TABLE}`).get() as {
      readonly n: number;
    }
  ).n;
  const chunks = (
    db.prepare(`SELECT COUNT(*) AS n FROM ${KNOWLEDGE_CHUNK_TABLE}`).get() as {
      readonly n: number;
    }
  ).n;
  return {
    entries,
    chunks,
    vectors: vectorIndex?.count() ?? 0,
    ...(vectorIndex === undefined
      ? {}
      : {
          vectorBackend: vectorIndex.backend,
          vectorDimensions: vectorIndex.dimensions,
          vectorModel: vectorIndex.model,
        }),
  };
}

/** 列出全部条目（按导入时间倒序，来源管理页用）。 */
export function listKnowledgeEntries(db: Database.Database): readonly KnowledgeEntryRow[] {
  const rows = db
    .prepare(`SELECT * FROM ${KNOWLEDGE_ENTRY_TABLE} ORDER BY imported_at DESC, entry_rowid DESC`)
    .all() as EntryDbRow[];
  return rows.map((row) => ({
    entryRowid: row.entry_rowid,
    entry: toEntry(row, readTags(db, row.entry_rowid)),
  }));
}

/** 读取某条目的全部块（按 seq 升序），供导出 Markdown（§8.3.6）与重建向量使用。 */
export function listEntryChunks(
  db: Database.Database,
  entryId: KnowledgeEntryId,
): readonly KnowledgeChunk[] {
  const rows = db
    .prepare(
      `SELECT ${CHUNK_SELECT_COLUMNS}
       FROM ${KNOWLEDGE_CHUNK_TABLE}
       JOIN ${KNOWLEDGE_ENTRY_TABLE}
         ON ${KNOWLEDGE_ENTRY_TABLE}.entry_rowid = ${KNOWLEDGE_CHUNK_TABLE}.entry_rowid
       WHERE ${KNOWLEDGE_ENTRY_TABLE}.id = ?
       ORDER BY ${KNOWLEDGE_CHUNK_TABLE}.seq`,
    )
    .all(entryId) as ChunkDbRow[];
  return rows.map(toKnowledgeChunk);
}

/** 清空整个知识库索引（含向量）。派生数据的核选项，用于「全部重建」。 */
export function clearKnowledgeIndex(db: Database.Database, vectorIndex?: VectorIndex): void {
  db.transaction(() => {
    vectorIndex?.clear();
    db.prepare(`DELETE FROM ${KNOWLEDGE_ENTRY_TABLE}`).run();
  })();
}
