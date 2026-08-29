/**
 * 记忆索引的低层原语(W1.3a):单条 upsert/delete、全量重建、BM25 match 查询。
 * 只操作派生索引,不读写 Markdown 真实源。
 * W1.3b 在此之上包装:增删改钩子(基于 upsert/delete)与业务检索 API(基于 search)。
 */

import type { MemoryCategory, MemoryEntry, MemoryEntryId, MemoryStatus } from "@ff-pane/shared";
import type Database from "better-sqlite3";
import { MEMORY_CONTENT_TABLE, MEMORY_FTS_TABLE } from "./schema.js";

/** 影子表一行的绑定参数(触发器随写同步 FTS)。 */
interface MemoryRowParams {
  readonly id: string;
  readonly category: string;
  readonly status: string;
  readonly title: string;
  readonly body: string;
  readonly tags: string;
}

const UPSERT_SQL = `
INSERT INTO ${MEMORY_CONTENT_TABLE} (id, category, status, title, body, tags)
VALUES (@id, @category, @status, @title, @body, @tags)
ON CONFLICT(id) DO UPDATE SET
  category = excluded.category,
  status = excluded.status,
  title = excluded.title,
  body = excluded.body,
  tags = excluded.tags
`;

function toRowParams(entry: MemoryEntry): MemoryRowParams {
  return {
    id: entry.id,
    category: entry.category,
    status: entry.status,
    title: entry.title,
    body: entry.body,
    tags: entry.tags?.join(" ") ?? "",
  };
}

/** 写入或覆盖一条记忆的索引行(W1.3b 增改钩子的基座)。 */
export function upsertMemoryEntry(db: Database.Database, entry: MemoryEntry): void {
  db.prepare<MemoryRowParams>(UPSERT_SQL).run(toRowParams(entry));
}

/** 删除一条记忆的索引行。条目不存在时静默(删除语义天然幂等)。 */
export function deleteMemoryEntry(db: Database.Database, id: MemoryEntryId): void {
  db.prepare<[string]>(`DELETE FROM ${MEMORY_CONTENT_TABLE} WHERE id = ?`).run(id);
}

/**
 * 全量重建:清空后重灌全部条目,单事务原子完成(中途失败回滚到旧索引)。
 * 索引是派生数据(设计文档 §8.4)——删除 DB 文件后由本函数从 Markdown
 * 真实源完全恢复。返回灌入条数。
 */
export function rebuildIndex(db: Database.Database, entries: Iterable<MemoryEntry>): number {
  const upsert = db.prepare<MemoryRowParams>(UPSERT_SQL);
  let count = 0;
  db.transaction(() => {
    db.prepare(`DELETE FROM ${MEMORY_CONTENT_TABLE}`).run();
    for (const entry of entries) {
      upsert.run(toRowParams(entry));
      count += 1;
    }
  })();
  return count;
}

/**
 * 把任意文本转成 FTS5 短语字面量:内部双引号翻倍后整体加引号。
 * 用户输入务必先经此转义再进 match,避免触碰 FTS5 查询语法(AND/OR/NEAR 等)。
 * 注意 trigram 分词下短语须 ≥3 个码点,更短的查询产生零 token、恒不命中。
 */
export function quoteFtsQueryLiteral(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/** searchMemoryIndex 缺省返回上限。 */
export const DEFAULT_SEARCH_LIMIT = 50;

/** searchMemoryIndex 的参数。 */
export interface MemoryIndexSearchOptions {
  /**
   * FTS5 MATCH 表达式,原样下传(语法责任在调用方)。
   * 纯文本查询请先经 quoteFtsQueryLiteral 转义。
   */
  readonly match: string;
  /** 类别过滤:列出则仅命中所列类别(OR 语义);省略则不过滤。 */
  readonly categories?: readonly MemoryCategory[];
  /** 状态过滤:同上。 */
  readonly statuses?: readonly MemoryStatus[];
  /** 返回条数上限,缺省 DEFAULT_SEARCH_LIMIT。 */
  readonly limit?: number;
}

/** BM25 命中行。索引不承担条目回读职责,正文由 W1.3b 凭 id 从真实源取。 */
export interface MemoryIndexHit {
  readonly id: MemoryEntryId;
  readonly category: MemoryCategory;
  readonly status: MemoryStatus;
  readonly title: string;
  /** bm25() 原始分:越小(越负)相关性越高,升序即最优在前。 */
  readonly score: number;
}

/**
 * BM25 列权重(title, body, tags):短标题命中比长正文命中更能代表条目主题,
 * 故 title 加权;tags 是人工提炼的关键词,居中。
 */
const BM25_WEIGHTS = { title: 2.0, body: 1.0, tags: 1.5 } as const;

/**
 * BM25 排序的 match 查询,支持 category/status 过滤组合。
 * 过滤列只存在影子表,经 rowid JOIN 参与筛选,不影响分词与打分。
 */
export function searchMemoryIndex(
  db: Database.Database,
  options: MemoryIndexSearchOptions,
): MemoryIndexHit[] {
  const conditions = [`${MEMORY_FTS_TABLE} MATCH ?`];
  const params: (string | number)[] = [options.match];

  for (const [column, values] of [
    ["category", options.categories],
    ["status", options.statuses],
  ] as const) {
    if (values !== undefined && values.length > 0) {
      const placeholders = values.map(() => "?").join(", ");
      conditions.push(`${MEMORY_CONTENT_TABLE}.${column} IN (${placeholders})`);
      params.push(...values);
    }
  }
  params.push(options.limit ?? DEFAULT_SEARCH_LIMIT);

  const sql = `
    SELECT
      ${MEMORY_CONTENT_TABLE}.id AS id,
      ${MEMORY_CONTENT_TABLE}.category AS category,
      ${MEMORY_CONTENT_TABLE}.status AS status,
      ${MEMORY_CONTENT_TABLE}.title AS title,
      bm25(${MEMORY_FTS_TABLE}, ${BM25_WEIGHTS.title}, ${BM25_WEIGHTS.body}, ${BM25_WEIGHTS.tags}) AS score
    FROM ${MEMORY_FTS_TABLE}
    JOIN ${MEMORY_CONTENT_TABLE} ON ${MEMORY_CONTENT_TABLE}.entry_rowid = ${MEMORY_FTS_TABLE}.rowid
    WHERE ${conditions.join(" AND ")}
    ORDER BY score, ${MEMORY_CONTENT_TABLE}.id
    LIMIT ?
  `;

  return db.prepare(sql).all(...params) as MemoryIndexHit[];
}
