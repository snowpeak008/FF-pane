/**
 * 知识库混合检索（T6.4，设计文档 §8.3.4）。
 *
 * ```
 * 过滤（来源目录 / 格式 / 标签 / 时间）
 *   → FTS5 BM25 召回 ┐
 *   → 向量 KNN 召回  ┴→ RRF 融合 → 上下文扩展（前后相邻块）→ KnowledgeHit[]
 * ```
 *
 * 三处需要交代的决定：
 *
 * 1. **过滤先于召回，且尽量做成精确前置**。先按过滤条件算出候选 rowid 集合，
 *    再把集合下推到两路召回。vec0 实测支持 `rowid IN (...)` 精确预过滤（T6.4 R2
 *    验证），故「过滤后的 top-k」是真 top-k，而不是「全局 top-k 再筛掉一部分」——
 *    后者在过滤条件较严时会大量少给结果（全局前 20 名可能一条都不在过滤范围内）。
 *    候选集大到超过 SQL 绑定参数上限时才退回「超额召回 + 事后过滤」：那种情形
 *    意味着过滤很宽松，全局 top-k 本来就大部分都在范围内，近似的代价很小。
 *    两个区间恰好互补。
 *
 * 2. **未配嵌入模型时向量路整条缺席，不是补零向量**。此时 RRF 退化成「只有 BM25
 *    一路」，结果顺序即 BM25 顺序——功能完整可用（§8.3.3「向量检索是增强，不是前提」）。
 *
 * 3. **上下文扩展在融合之后做**，只为最终要返回的那几条取相邻块。放在召回阶段
 *    做会把相邻块也卷进排序，等于让一次命中占掉三个名次。
 */

import { fuseByRrf, type RankedList } from "@ff-pane/rag";
import type { KnowledgeChunk, KnowledgeEntryId, KnowledgeFormat } from "@ff-pane/shared";
import type Database from "better-sqlite3";
import { toPosixPath } from "../index.js";
import { CHUNK_SELECT_COLUMNS, type ChunkDbRow, toKnowledgeChunk } from "./knowledge-index.js";
import {
  KNOWLEDGE_CHUNK_TABLE,
  KNOWLEDGE_ENTRY_TABLE,
  KNOWLEDGE_FTS_TABLE,
  KNOWLEDGE_TAG_TABLE,
} from "./knowledge-schema.js";
import type { VectorIndex } from "./knowledge-vector.js";
import { VECTOR_PREFILTER_MAX_CANDIDATES } from "./knowledge-vector.js";

/** 缺省返回条数。 */
export const DEFAULT_KNOWLEDGE_SEARCH_LIMIT = 20;

/**
 * 单路召回的取数倍率：每路各取 limit × 本值，融合后再截到 limit。
 * 只取 limit 会让「A 路第 21 名但 B 路第 1 名」的强结果进不了融合池——
 * 那恰恰是混合检索最想捞到的那类命中。
 */
export const RECALL_MULTIPLIER = 4;

/**
 * 走 FTS 路径所需的最少码点数（trigram 分词的固有下限，同记忆索引）。
 * 更短的查询产生零 token、恒不命中，故自动回退 LIKE 子串扫描。
 */
export const KNOWLEDGE_FTS_MIN_QUERY_CODE_POINTS = 3;

/** 过滤条件（§8.3.4 过滤维度：来源目录 / 格式 / 标签 / 导入时间）。 */
export interface KnowledgeFilters {
  /** 格式过滤（OR 语义）；省略或空数组不过滤。 */
  readonly formats?: readonly KnowledgeFormat[];
  /** 标签过滤（OR 语义：命中任一标签即可）。 */
  readonly tags?: readonly string[];
  /** 来源目录前缀（file_import 条目的导入路径）。分隔符自动归一为正斜杠。 */
  readonly sourcePathPrefix?: string;
  /** 导入时间下界（含，epoch 毫秒）。 */
  readonly importedAfter?: number;
  /** 导入时间上界（含，epoch 毫秒）。 */
  readonly importedBefore?: number;
  /** 限定在若干条目内检索（会话内「只搜这几篇」）。 */
  readonly entryIds?: readonly KnowledgeEntryId[];
}

/** 一条命中所走的召回路径。 */
export type KnowledgeMatchSource = "fts" | "like-fallback" | "vector";

/** 混合检索的一条命中（在 KnowledgeHit 之上补命中来源与两路名次）。 */
export interface KnowledgeSearchHit {
  /** 命中块。 */
  readonly chunk: KnowledgeChunk;
  /** RRF 融合分（越大越靠前）。 */
  readonly score: number;
  /** 命中它的召回路径。两路都有时说明关键词与语义一致，通常是最可信的命中。 */
  readonly sources: readonly KnowledgeMatchSource[];
  /** 各路名次（从 1 起），未命中的路缺席。 */
  readonly ranks: Readonly<Record<string, number>>;
  /** 上下文扩展：命中块之前的相邻块（按 seq 升序）。 */
  readonly before: readonly KnowledgeChunk[];
  /** 上下文扩展：命中块之后的相邻块（按 seq 升序）。 */
  readonly after: readonly KnowledgeChunk[];
}

/** 检索结果 + 本次实际走了哪些路（界面据此说明「向量检索未启用」等情况）。 */
export interface KnowledgeSearchResult {
  /** 命中列表。 */
  readonly hits: readonly KnowledgeSearchHit[];
  /** 关键词路是否走了 FTS（false 表示查询过短、回退了 LIKE 子串扫描）。 */
  readonly usedFts: boolean;
  /** 向量路是否参与（未配嵌入模型 / 未建向量索引 / 未给查询向量时为 false）。 */
  readonly usedVector: boolean;
  /**
   * 向量路的过滤是否为精确前置。false 表示候选集过大、走了「超额召回 + 事后过滤」，
   * 向量路结果为近似（见模块注释第 1 条）。
   */
  readonly vectorPrefilterExact: boolean;
}

/** 检索参数。 */
export interface KnowledgeSearchOptions {
  /** 用户原始输入（首尾空白由本层去除）。空白查询在无查询向量时返回空结果。 */
  readonly query: string;
  /**
   * 查询向量（由调用方用同一嵌入模型对 query 编码得到）。
   * 省略即向量路缺席，退化为纯 FTS——这正是「未配嵌入模型」的表达。
   */
  readonly queryVector?: readonly number[];
  /** 向量索引；省略同上。 */
  readonly vectorIndex?: VectorIndex;
  /** 过滤条件。 */
  readonly filters?: KnowledgeFilters;
  /** 返回条数上限，缺省 DEFAULT_KNOWLEDGE_SEARCH_LIMIT。 */
  readonly limit?: number;
  /** 上下文扩展：向前取几块，缺省 1。0 表示不扩展。 */
  readonly contextBefore?: number;
  /** 上下文扩展：向后取几块，缺省 1。 */
  readonly contextAfter?: number;
}

/** LIKE 的转义符（同记忆索引）。 */
const LIKE_ESCAPE_CHAR = "\\";

/** 把任意文本转成「包含该文本」的 LIKE 模式：转义符自身与通配符全部按字面处理。 */
function toLikeContainsPattern(text: string): string {
  return `%${escapeLike(text)}%`;
}

function escapeLike(text: string): string {
  return text
    .replaceAll(LIKE_ESCAPE_CHAR, `${LIKE_ESCAPE_CHAR}${LIKE_ESCAPE_CHAR}`)
    .replaceAll("%", `${LIKE_ESCAPE_CHAR}%`)
    .replaceAll("_", `${LIKE_ESCAPE_CHAR}_`);
}

/** FTS5 短语字面量：内部双引号翻倍后整体加引号，用户输入不触碰查询语法。 */
export function quoteKnowledgeFtsLiteral(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/** 过滤条件编译成的 SQL 片段。 */
interface CompiledFilters {
  /** 追加到 WHERE 的条件（不含前导 AND）；无过滤时为空数组。 */
  readonly conditions: readonly string[];
  /** 与 conditions 对应的绑定值。 */
  readonly bindings: readonly (string | number)[];
}

/**
 * 把过滤条件编译成作用在 knowledge_entry 上的 SQL 片段。
 * 全部维度都落在条目行上，故任何查询只要 JOIN 了条目表就能复用这段。
 */
function compileFilters(filters: KnowledgeFilters | undefined): CompiledFilters {
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];
  if (filters === undefined) {
    return { conditions, bindings };
  }

  if (filters.formats !== undefined && filters.formats.length > 0) {
    conditions.push(
      `${KNOWLEDGE_ENTRY_TABLE}.format IN (${filters.formats.map(() => "?").join(", ")})`,
    );
    bindings.push(...filters.formats);
  }
  if (filters.entryIds !== undefined && filters.entryIds.length > 0) {
    conditions.push(
      `${KNOWLEDGE_ENTRY_TABLE}.id IN (${filters.entryIds.map(() => "?").join(", ")})`,
    );
    bindings.push(...filters.entryIds);
  }
  if (filters.tags !== undefined && filters.tags.length > 0) {
    // EXISTS 而不是 JOIN：JOIN 会因一条目多标签而产生重复行，还得再 DISTINCT
    conditions.push(
      `EXISTS (SELECT 1 FROM ${KNOWLEDGE_TAG_TABLE}
               WHERE ${KNOWLEDGE_TAG_TABLE}.entry_rowid = ${KNOWLEDGE_ENTRY_TABLE}.entry_rowid
                 AND ${KNOWLEDGE_TAG_TABLE}.tag IN (${filters.tags.map(() => "?").join(", ")}))`,
    );
    bindings.push(...filters.tags);
  }
  const prefix = filters.sourcePathPrefix?.trim() ?? "";
  if (prefix !== "") {
    conditions.push(`${KNOWLEDGE_ENTRY_TABLE}.origin_path LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'`);
    bindings.push(`${escapeLike(toPosixPath(prefix))}%`);
  }
  if (filters.importedAfter !== undefined) {
    conditions.push(`${KNOWLEDGE_ENTRY_TABLE}.imported_at >= ?`);
    bindings.push(filters.importedAfter);
  }
  if (filters.importedBefore !== undefined) {
    conditions.push(`${KNOWLEDGE_ENTRY_TABLE}.imported_at <= ?`);
    bindings.push(filters.importedBefore);
  }
  return { conditions, bindings };
}

/** 块表 JOIN 条目表的公共 FROM 片段。 */
const CHUNK_JOIN_ENTRY = `
  FROM ${KNOWLEDGE_CHUNK_TABLE}
  JOIN ${KNOWLEDGE_ENTRY_TABLE}
    ON ${KNOWLEDGE_ENTRY_TABLE}.entry_rowid = ${KNOWLEDGE_CHUNK_TABLE}.entry_rowid
`;

/**
 * BM25 列权重（text, heading）。
 * 小节标题命中比正文命中更能代表块的主题，故 heading 加权——与记忆索引给 title
 * 加权同一取向。
 */
const BM25_WEIGHTS = { text: 1.0, heading: 2.0 } as const;

/** 按过滤条件算出候选块 rowid 集合（精确前置过滤用）。 */
export function collectCandidateRowids(
  db: Database.Database,
  filters: KnowledgeFilters | undefined,
  max: number,
): { readonly rowids: number[]; readonly exact: boolean } {
  const compiled = compileFilters(filters);
  if (compiled.conditions.length === 0) {
    // 无过滤 = 全库，不需要候选集
    return { rowids: [], exact: true };
  }
  const rows = db
    .prepare(
      `SELECT ${KNOWLEDGE_CHUNK_TABLE}.chunk_rowid AS rowid
       ${CHUNK_JOIN_ENTRY}
       WHERE ${compiled.conditions.join(" AND ")}
       LIMIT ?`,
    )
    .all(...compiled.bindings, max + 1) as { readonly rowid: number }[];
  // 多取一条用于判断是否超限：超了就说明不能走精确 IN 预过滤
  if (rows.length > max) {
    return { rowids: [], exact: false };
  }
  return { rowids: rows.map((row) => row.rowid), exact: true };
}

/** FTS5 BM25 召回（带过滤）。返回按相关度降序的块 rowid。 */
function recallByFts(
  db: Database.Database,
  query: string,
  filters: KnowledgeFilters | undefined,
  limit: number,
): number[] {
  const compiled = compileFilters(filters);
  const conditions = [`${KNOWLEDGE_FTS_TABLE} MATCH ?`, ...compiled.conditions];
  const rows = db
    .prepare(
      `SELECT ${KNOWLEDGE_CHUNK_TABLE}.chunk_rowid AS rowid,
              bm25(${KNOWLEDGE_FTS_TABLE}, ${BM25_WEIGHTS.text}, ${BM25_WEIGHTS.heading}) AS score
       FROM ${KNOWLEDGE_FTS_TABLE}
       JOIN ${KNOWLEDGE_CHUNK_TABLE}
         ON ${KNOWLEDGE_CHUNK_TABLE}.chunk_rowid = ${KNOWLEDGE_FTS_TABLE}.rowid
       JOIN ${KNOWLEDGE_ENTRY_TABLE}
         ON ${KNOWLEDGE_ENTRY_TABLE}.entry_rowid = ${KNOWLEDGE_CHUNK_TABLE}.entry_rowid
       WHERE ${conditions.join(" AND ")}
       ORDER BY score, ${KNOWLEDGE_CHUNK_TABLE}.chunk_rowid
       LIMIT ?`,
    )
    .all(quoteKnowledgeFtsLiteral(query), ...compiled.bindings, limit) as {
    readonly rowid: number;
  }[];
  return rows.map((row) => row.rowid);
}

/**
 * LIKE 子串回退（查询短于 trigram 下限时）。
 * 与 FTS 路同为子串语义，差别只在没有 BM25 相关性打分——排序取
 * 「标题路径命中优先，其次块序」的确定性次序。
 */
function recallByLike(
  db: Database.Database,
  query: string,
  filters: KnowledgeFilters | undefined,
  limit: number,
): number[] {
  const compiled = compileFilters(filters);
  const textMatch = `${KNOWLEDGE_CHUNK_TABLE}.text LIKE @pattern ESCAPE '${LIKE_ESCAPE_CHAR}'`;
  const headingMatch = `COALESCE(${KNOWLEDGE_CHUNK_TABLE}.heading_path, '') LIKE @pattern ESCAPE '${LIKE_ESCAPE_CHAR}'`;
  const conditions = [`(${textMatch} OR ${headingMatch})`, ...compiled.conditions];

  // compileFilters 产出的是位置参数（?），这里混用了命名参数（@pattern），
  // better-sqlite3 不允许两种混写，故把过滤绑定也转成命名参数
  const named: Record<string, string | number> = {
    pattern: toLikeContainsPattern(query),
    limit,
  };
  let cursor = 0;
  const conditionsWithNames = conditions.map((condition) =>
    condition.replaceAll("?", () => {
      const name = `f${cursor}`;
      named[name] = compiled.bindings[cursor] as string | number;
      cursor += 1;
      return `@${name}`;
    }),
  );

  const rows = db
    .prepare(
      `SELECT ${KNOWLEDGE_CHUNK_TABLE}.chunk_rowid AS rowid
       ${CHUNK_JOIN_ENTRY}
       WHERE ${conditionsWithNames.join(" AND ")}
       ORDER BY CASE WHEN ${headingMatch} THEN 0 ELSE 1 END,
                ${KNOWLEDGE_CHUNK_TABLE}.chunk_rowid
       LIMIT @limit`,
    )
    .all(named) as { readonly rowid: number }[];
  return rows.map((row) => row.rowid);
}

/** 按 rowid 批量读回块（保持传入顺序）。 */
function loadChunksByRowid(
  db: Database.Database,
  rowids: readonly number[],
): Map<number, KnowledgeChunk> {
  const found = new Map<number, KnowledgeChunk>();
  if (rowids.length === 0) {
    return found;
  }
  const rows = db
    .prepare(
      `SELECT ${CHUNK_SELECT_COLUMNS}
       ${CHUNK_JOIN_ENTRY}
       WHERE ${KNOWLEDGE_CHUNK_TABLE}.chunk_rowid IN (${rowids.map(() => "?").join(", ")})`,
    )
    .all(...rowids) as ChunkDbRow[];
  for (const row of rows) {
    found.set(row.chunk_rowid, toKnowledgeChunk(row));
  }
  return found;
}

/**
 * 上下文扩展（§8.3.4）：取同一条目内 seq 相邻的块。
 * 按 (entry_rowid, seq) 的唯一索引直接取区间，不需要额外索引。
 */
export function expandContext(
  db: Database.Database,
  chunkRowid: number,
  before: number,
  after: number,
): { readonly before: KnowledgeChunk[]; readonly after: KnowledgeChunk[] } {
  if (before <= 0 && after <= 0) {
    return { before: [], after: [] };
  }
  const anchor = db
    .prepare(`SELECT entry_rowid, seq FROM ${KNOWLEDGE_CHUNK_TABLE} WHERE chunk_rowid = ?`)
    .get(chunkRowid) as { readonly entry_rowid: number; readonly seq: number } | undefined;
  if (anchor === undefined) {
    return { before: [], after: [] };
  }
  const rows = db
    .prepare(
      `SELECT ${CHUNK_SELECT_COLUMNS}
       ${CHUNK_JOIN_ENTRY}
       WHERE ${KNOWLEDGE_CHUNK_TABLE}.entry_rowid = ?
         AND ${KNOWLEDGE_CHUNK_TABLE}.seq BETWEEN ? AND ?
         AND ${KNOWLEDGE_CHUNK_TABLE}.chunk_rowid <> ?
       ORDER BY ${KNOWLEDGE_CHUNK_TABLE}.seq`,
    )
    .all(
      anchor.entry_rowid,
      anchor.seq - Math.max(0, before),
      anchor.seq + Math.max(0, after),
      chunkRowid,
    ) as ChunkDbRow[];

  const beforeChunks: KnowledgeChunk[] = [];
  const afterChunks: KnowledgeChunk[] = [];
  for (const row of rows) {
    (row.seq < anchor.seq ? beforeChunks : afterChunks).push(toKnowledgeChunk(row));
  }
  return { before: beforeChunks, after: afterChunks };
}

/**
 * 混合检索：FTS5 BM25 与向量双路召回 → RRF 融合 → 上下文扩展。
 *
 * 空白查询且无查询向量时返回空结果（搜索框清空不该看到异常）；
 * 只给查询向量、不给文字（"找相似块"）也是合法用法，此时只走向量路。
 */
export function searchKnowledge(
  db: Database.Database,
  options: KnowledgeSearchOptions,
): KnowledgeSearchResult {
  const query = options.query.trim();
  const limit = Math.max(0, options.limit ?? DEFAULT_KNOWLEDGE_SEARCH_LIMIT);
  const recallLimit = Math.max(limit * RECALL_MULTIPLIER, limit);
  const vectorReady =
    options.vectorIndex !== undefined &&
    options.queryVector !== undefined &&
    options.queryVector.length > 0;

  if ((query === "" && !vectorReady) || limit === 0) {
    return { hits: [], usedFts: false, usedVector: false, vectorPrefilterExact: true };
  }

  const lists: RankedList<number>[] = [];
  let usedFts = false;

  if (query !== "") {
    const useFts = [...query].length >= KNOWLEDGE_FTS_MIN_QUERY_CODE_POINTS;
    usedFts = useFts;
    const ids = useFts
      ? recallByFts(db, query, options.filters, recallLimit)
      : recallByLike(db, query, options.filters, recallLimit);
    lists.push({ source: useFts ? "fts" : "like-fallback", ids });
  }

  let vectorPrefilterExact = true;
  let usedVector = false;
  if (vectorReady && options.vectorIndex !== undefined && options.queryVector !== undefined) {
    const candidates = collectCandidateRowids(db, options.filters, VECTOR_PREFILTER_MAX_CANDIDATES);
    vectorPrefilterExact = candidates.exact;
    const hasFilters = compileFilters(options.filters).conditions.length > 0;

    let neighbors = options.vectorIndex.search({
      vector: options.queryVector,
      // 过滤不精确时超额召回，把事后过滤的损耗提前补上
      limit: candidates.exact ? recallLimit : recallLimit * RECALL_MULTIPLIER,
      ...(hasFilters && candidates.exact ? { candidates: candidates.rowids } : {}),
    });
    if (hasFilters && !candidates.exact) {
      // 退路：候选集大到无法进 IN 列表，改为召回后按过滤条件复核
      const allowed = new Set(
        collectCandidateRowidsIn(
          db,
          options.filters,
          neighbors.map((neighbor) => neighbor.chunkRowid),
        ),
      );
      neighbors = neighbors.filter((neighbor) => allowed.has(neighbor.chunkRowid));
    }
    usedVector = true;
    lists.push({ source: "vector", ids: neighbors.slice(0, recallLimit).map((n) => n.chunkRowid) });
  }

  const fused = fuseByRrf(lists, { limit });
  const chunks = loadChunksByRowid(
    db,
    fused.map((hit) => hit.id),
  );
  const contextBefore = options.contextBefore ?? 1;
  const contextAfter = options.contextAfter ?? 1;

  const hits: KnowledgeSearchHit[] = [];
  for (const entry of fused) {
    const chunk = chunks.get(entry.id);
    if (chunk === undefined) {
      // 融合池里的 rowid 读不回块：索引内部不一致，跳过而不是让整次检索失败
      continue;
    }
    const context = expandContext(db, entry.id, contextBefore, contextAfter);
    hits.push({
      chunk,
      score: entry.score,
      sources: entry.sources as readonly KnowledgeMatchSource[],
      ranks: entry.ranks,
      before: context.before,
      after: context.after,
    });
  }

  return { hits, usedFts, usedVector, vectorPrefilterExact };
}

/** 在给定 rowid 集合中筛出满足过滤条件的那些（事后过滤路径用）。 */
function collectCandidateRowidsIn(
  db: Database.Database,
  filters: KnowledgeFilters | undefined,
  rowids: readonly number[],
): number[] {
  if (rowids.length === 0) {
    return [];
  }
  const compiled = compileFilters(filters);
  const conditions = [
    `${KNOWLEDGE_CHUNK_TABLE}.chunk_rowid IN (${rowids.map(() => "?").join(", ")})`,
    ...compiled.conditions,
  ];
  const rows = db
    .prepare(
      `SELECT ${KNOWLEDGE_CHUNK_TABLE}.chunk_rowid AS rowid
       ${CHUNK_JOIN_ENTRY}
       WHERE ${conditions.join(" AND ")}`,
    )
    .all(...rowids, ...compiled.bindings) as { readonly rowid: number }[];
  return rows.map((row) => row.rowid);
}
