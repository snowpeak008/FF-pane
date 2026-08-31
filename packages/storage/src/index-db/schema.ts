/**
 * 索引库 schema 迁移清单(唯一事实来源)——记忆 FTS5 索引(W1.3a)。
 *
 * v1 设计决策:
 * - external-content 方案:影子内容表 memory_entry + FTS5 虚表 memory_fts。
 *   索引整体是派生数据(设计文档 §8.4,真实源为 Markdown),影子表同为派生,
 *   可随时删库由 rebuildIndex 重建。相比 contentless:支持标准 UPDATE/DELETE
 *   语义(单条同步原语直接写影子表)、保留 snippet()/highlight() 能力、
 *   命中行可直接取回 title 等列,代价只是多存一份短文本,可接受。
 * - 过滤列(category/status)只存在于影子表,完全不进 FTS5 虚表,
 *   天然不参与分词;靠普通 B-tree 索引过滤,与 MATCH 结果按 rowid JOIN。
 * - tokenize='trigram':兼顾中英文子串检索(技术选型 §5,R4 已实测验证)。
 *   注意 trigram 要求查询词 ≥3 个码点,更短的查询产生零 token、不命中。
 * - 影子表与虚表经三只触发器保持同步,任何路径写影子表都不会漏同步 FTS。
 */

import { MEMORY_CATEGORIES, MEMORY_STATUSES } from "@ff-pane/shared";
import { KNOWLEDGE_MIGRATION_V2 } from "./knowledge-schema.js";
import type { IndexDbMigration } from "./migrations.js";

/** 记忆影子内容表(external content;派生数据,可随索引整体重建)。 */
export const MEMORY_CONTENT_TABLE = "memory_entry";

/** 记忆 FTS5 虚表。 */
export const MEMORY_FTS_TABLE = "memory_fts";

/** 由 as const 常量数组生成 SQL 字面量列表(CHECK 约束与领域类型永不脱节)。 */
function sqlLiteralList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

const MEMORY_SCHEMA_V1 = `
CREATE TABLE ${MEMORY_CONTENT_TABLE} (
  -- 显式 INTEGER PRIMARY KEY 别名 rowid,保证 rowid 稳定(隐式 rowid 会被 VACUUM 重排,踩坏 FTS 映射)
  entry_rowid INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL CHECK (category IN (${sqlLiteralList(MEMORY_CATEGORIES)})),
  status      TEXT NOT NULL CHECK (status IN (${sqlLiteralList(MEMORY_STATUSES)})),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  -- tags 以单空格拼接为可检索文本;条目完整内容以 Markdown 真实源为准,索引不承担回读职责
  tags        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_${MEMORY_CONTENT_TABLE}_category ON ${MEMORY_CONTENT_TABLE}(category);
CREATE INDEX idx_${MEMORY_CONTENT_TABLE}_status ON ${MEMORY_CONTENT_TABLE}(status);

CREATE VIRTUAL TABLE ${MEMORY_FTS_TABLE} USING fts5(
  title,
  body,
  tags,
  content='${MEMORY_CONTENT_TABLE}',
  content_rowid='entry_rowid',
  tokenize='trigram'
);

CREATE TRIGGER ${MEMORY_CONTENT_TABLE}_ai AFTER INSERT ON ${MEMORY_CONTENT_TABLE} BEGIN
  INSERT INTO ${MEMORY_FTS_TABLE}(rowid, title, body, tags)
  VALUES (new.entry_rowid, new.title, new.body, new.tags);
END;

CREATE TRIGGER ${MEMORY_CONTENT_TABLE}_ad AFTER DELETE ON ${MEMORY_CONTENT_TABLE} BEGIN
  INSERT INTO ${MEMORY_FTS_TABLE}(${MEMORY_FTS_TABLE}, rowid, title, body, tags)
  VALUES ('delete', old.entry_rowid, old.title, old.body, old.tags);
END;

CREATE TRIGGER ${MEMORY_CONTENT_TABLE}_au AFTER UPDATE ON ${MEMORY_CONTENT_TABLE} BEGIN
  INSERT INTO ${MEMORY_FTS_TABLE}(${MEMORY_FTS_TABLE}, rowid, title, body, tags)
  VALUES ('delete', old.entry_rowid, old.title, old.body, old.tags);
  INSERT INTO ${MEMORY_FTS_TABLE}(rowid, title, body, tags)
  VALUES (new.entry_rowid, new.title, new.body, new.tags);
END;
`;

/** 索引库迁移清单。openIndexDb 打开时自动逐级执行(见 migrations.ts)。 */
export const INDEX_DB_MIGRATIONS: readonly IndexDbMigration[] = [
  {
    toVersion: 1,
    description: "记忆 FTS5 索引:external-content 影子表 + trigram 虚表 + 同步触发器",
    up: (db) => {
      db.exec(MEMORY_SCHEMA_V1);
    },
  },
  // v2 知识库索引（T6.4）。定义在 knowledge-schema.ts,本清单只负责登记顺序。
  KNOWLEDGE_MIGRATION_V2,
];
