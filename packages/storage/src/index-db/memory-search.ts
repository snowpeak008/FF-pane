/**
 * 记忆业务检索 API(W1.3b):面向 UI 与注入策略的一个入口,封装 W1.3a 的
 * 原始 MATCH 查询,补齐三件业务层必须管的事。
 *
 * 1. 转义:用户原始输入一律先经 quoteFtsQueryLiteral,调用方不接触 FTS5 查询语法。
 * 2. 短查询回退:trigram 分词要求查询 ≥3 个码点,更短的查询产生零 token、恒不命中,
 *    而"测试""登录"这类中文双字词恰是最常见的输入。此时回退到影子表 LIKE 子串扫描,
 *    命中标注 matchKind: "like-fallback",与 FTS 路径("fts")区分开——两条路径都是
 *    子串语义,差别只在 LIKE 无 BM25 相关性打分,且随条目数线性扫描(记忆是短文本、
 *    量级在百到千条,可接受)。
 * 3. 回读:索引只存可检索文本,hydrate: true 时凭命中 id 从 Markdown 真实源
 *    (设计文档 §8.4)取回完整条目;读不回的条目进 issues 并从命中中剔除,
 *    不让一个损坏文件毁掉整次检索。
 *
 * 查询前先去掉首尾空白(搜索框语义),空白查询返回空结果而非报错——UI 输入框
 * 清空时不该看到异常。
 */

import type { MemoryCategory, MemoryEntry, MemoryEntryId, MemoryStatus } from "@ff-pane/shared";
import type Database from "better-sqlite3";
import type { ProjectLayout } from "../fs/index.js";
import type { MemoryEntryLoadError } from "../memory/index.js";
import { loadEntry } from "../memory/index.js";
import type { MemoryIndexSearchOptions } from "./memory-index.js";
import { DEFAULT_SEARCH_LIMIT, quoteFtsQueryLiteral, searchMemoryIndex } from "./memory-index.js";
import { MEMORY_CONTENT_TABLE } from "./schema.js";

/**
 * 走 FTS 路径所需的最少码点数(trigram 分词的固有下限)。
 * 更短的查询由 searchMemory 自动回退 LIKE;UI 若要提示"已按子串匹配",
 * 可用 [...query.trim()].length 与本常量比较。
 */
export const MEMORY_FTS_MIN_QUERY_CODE_POINTS = 3;

/** 命中来自哪条匹配路径(见模块注释第 2 条)。 */
export type MemoryMatchKind = "fts" | "like-fallback";

/** 业务检索的一条命中。 */
export interface MemorySearchHit {
  /** 条目 ID(回读真实源的唯一凭据)。 */
  readonly id: MemoryEntryId;
  readonly category: MemoryCategory;
  readonly status: MemoryStatus;
  readonly title: string;
  /** 本条命中所走的匹配路径。 */
  readonly matchKind: MemoryMatchKind;
  /** BM25 原始分(越小越相关)。仅 "fts" 路径有;LIKE 回退无相关性打分,字段缺席。 */
  readonly score?: number;
  /** hydrate: true 时回读的完整条目(读不回的命中已进 issues 并被剔除,故此时必定存在)。 */
  readonly entry?: MemoryEntry;
}

/** searchMemory 的公共参数(过滤与上限语义沿用 W1.3a)。 */
export interface MemorySearchBaseOptions {
  /** 用户原始输入,不需要预处理转义(首尾空白由本层去除)。 */
  readonly query: string;
  /** 类别过滤:列出则仅命中所列类别(OR 语义);省略或空数组均不过滤。 */
  readonly categories?: readonly MemoryCategory[];
  /** 状态过滤:同上。 */
  readonly statuses?: readonly MemoryStatus[];
  /** 返回条数上限,缺省 DEFAULT_SEARCH_LIMIT(两条路径同一口径)。 */
  readonly limit?: number;
}

/**
 * searchMemory 的参数。hydrate: true 必须同时给出 layout(回读真实源的目录布局),
 * 由类型强制——运行到一半才发现少传路径,对 UI 是最糟的失败方式。
 */
export type MemorySearchOptions =
  | (MemorySearchBaseOptions & { readonly hydrate?: false; readonly layout?: ProjectLayout })
  | (MemorySearchBaseOptions & { readonly hydrate: true; readonly layout: ProjectLayout });

/** hydrate 阶段被跳过的命中:索引里有、真实源读不回(索引陈旧或文件损坏)。 */
export interface MemoryHydrateIssue {
  /** 读不回的条目 ID。 */
  readonly entryId: MemoryEntryId;
  /** 具体失败原因(文件路径 / 字段等上下文在 error 自身携带)。 */
  readonly error: MemoryEntryLoadError;
}

/** searchMemory 的结果。 */
export interface MemorySearchResult {
  /** 命中列表,已按路径各自的确定性顺序排好(FTS 按 BM25,LIKE 按命中列优先级)。 */
  readonly hits: readonly MemorySearchHit[];
  /**
   * hydrate 阶段跳过的条目;hydrate: false 时恒为空。
   * 非空说明索引与真实源已不同步,调用方宜上报并考虑 rebuildIndexFromStore。
   */
  readonly issues: readonly MemoryHydrateIssue[];
}

/** LIKE 的转义符。SQLite 字符串字面量不处理反斜杠转义,故 '\' 就是单个反斜杠。 */
const LIKE_ESCAPE_CHAR = "\\";

/** 把任意文本转成「包含该文本」的 LIKE 模式:转义符自身与通配符 % _ 全部按字面处理。 */
function toLikeContainsPattern(text: string): string {
  const escaped = text
    .replaceAll(LIKE_ESCAPE_CHAR, `${LIKE_ESCAPE_CHAR}${LIKE_ESCAPE_CHAR}`)
    .replaceAll("%", `${LIKE_ESCAPE_CHAR}%`)
    .replaceAll("_", `${LIKE_ESCAPE_CHAR}_`);
  return `%${escaped}%`;
}

function likeMatches(column: string): string {
  return `${column} LIKE @pattern ESCAPE '${LIKE_ESCAPE_CHAR}'`;
}

/** LIKE 回退的命中行(影子表列,不含打分)。 */
interface LikeRow {
  readonly id: MemoryEntryId;
  readonly category: MemoryCategory;
  readonly status: MemoryStatus;
  readonly title: string;
}

/**
 * 影子表 LIKE 子串扫描:title / body / tags 任一命中即返回。
 * 排序没有 BM25 可用,取「标题命中 > 标签命中 > 正文命中」的确定性次序
 * (与 W1.3a 的 BM25 列权重同一取向:短标题命中更能代表条目主题),同档按 id 升序。
 */
function searchByLike(
  db: Database.Database,
  query: string,
  options: MemorySearchBaseOptions,
): MemorySearchHit[] {
  const params: Record<string, string | number> = {
    pattern: toLikeContainsPattern(query),
    limit: options.limit ?? DEFAULT_SEARCH_LIMIT,
  };
  const conditions = [
    `(${likeMatches("title")} OR ${likeMatches("body")} OR ${likeMatches("tags")})`,
  ];

  for (const [column, values] of [
    ["category", options.categories],
    ["status", options.statuses],
  ] as const) {
    if (values !== undefined && values.length > 0) {
      const names: string[] = [];
      for (const [index, value] of values.entries()) {
        const name = `${column}${index}`;
        names.push(`@${name}`);
        params[name] = value;
      }
      conditions.push(`${column} IN (${names.join(", ")})`);
    }
  }

  const sql = `
    SELECT id, category, status, title
    FROM ${MEMORY_CONTENT_TABLE}
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE
        WHEN ${likeMatches("title")} THEN 0
        WHEN ${likeMatches("tags")} THEN 1
        ELSE 2
      END,
      id
    LIMIT @limit
  `;

  const rows = db.prepare(sql).all(params) as LikeRow[];
  return rows.map((row) => ({ ...row, matchKind: "like-fallback" as const }));
}

/** FTS 路径:用户输入经 quoteFtsQueryLiteral 转成短语字面量后下传 W1.3a。 */
function searchByFts(
  db: Database.Database,
  query: string,
  options: MemorySearchBaseOptions,
): MemorySearchHit[] {
  const indexOptions: MemoryIndexSearchOptions = {
    match: quoteFtsQueryLiteral(query),
    ...(options.categories === undefined ? {} : { categories: options.categories }),
    ...(options.statuses === undefined ? {} : { statuses: options.statuses }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  };
  return searchMemoryIndex(db, indexOptions).map((hit) => ({
    ...hit,
    matchKind: "fts" as const,
  }));
}

async function hydrateHits(
  layout: ProjectLayout,
  hits: readonly MemorySearchHit[],
): Promise<MemorySearchResult> {
  const hydrated: MemorySearchHit[] = [];
  const issues: MemoryHydrateIssue[] = [];
  for (const hit of hits) {
    const loaded = await loadEntry(layout, hit.id);
    if (!loaded.ok) {
      issues.push({ entryId: hit.id, error: loaded.error });
      continue;
    }
    hydrated.push({ ...hit, entry: loaded.value });
  }
  return { hits: hydrated, issues };
}

/**
 * 检索记忆条目:自动选择 FTS 或 LIKE 回退路径(见模块注释),
 * 可选按 id 从真实源回读完整条目。空白 query 返回空结果。
 */
export async function searchMemory(
  db: Database.Database,
  options: MemorySearchOptions,
): Promise<MemorySearchResult> {
  const query = options.query.trim();
  if (query === "") {
    return { hits: [], issues: [] };
  }

  const hits =
    [...query].length < MEMORY_FTS_MIN_QUERY_CODE_POINTS
      ? searchByLike(db, query, options)
      : searchByFts(db, query, options);

  if (options.hydrate !== true) {
    return { hits, issues: [] };
  }
  return await hydrateHits(options.layout, hits);
}
