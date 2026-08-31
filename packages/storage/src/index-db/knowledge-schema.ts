/**
 * 知识库索引 schema（T6.4 迁移 v2，设计文档 §8.3）。
 *
 * 与记忆索引（v1）同一套路数，也同一条纪律：**索引整体是派生数据**（§8.4）。
 * 真实源是原文件；条目、块、FTS、向量全部可由「解析 → 分块 → 索引 → 嵌入」
 * 重跑得到，故迁移只做前向升级，任何修不好的状态兜底都是删库重建。
 *
 * 三处与 v1 不同的决定：
 *
 * 1. **检索单元是块，过滤维度在条目上**（§8.3.4 过滤维度：来源目录/格式/标签/时间）。
 *    故 chunk 表带 entry_rowid 外键，过滤一律经 JOIN 落到条目行，
 *    FTS 虚表里只放参与分词的两列，过滤列一个都不进去。
 *
 * 2. **标签单独一张表而不是拼接文本**。记忆的 tags 是拼成空格串塞进 FTS 的
 *    （那里 tags 要参与检索），知识库的 tags 只用于**过滤**——拼接文本做过滤
 *    要么 LIKE 全扫、要么误伤子串（"api" 命中 "rapid"）。一行一标签 + 索引，
 *    既精确又走得动索引。条目的 tags 读回时由本表 GROUP 出来，不留第二份副本。
 *
 * 3. **向量表不在迁移里建**。vec0 虚表的维度在 CREATE 时就固定，而维度取决于
 *    用户配了哪个嵌入模型——迁移执行时根本不知道。故 v2 只建一张记录后端与维度的
 *    状态表，真正的向量表由 ensureVectorIndex 在首次落向量时惰性创建（见 knowledge-vector.ts）。
 */

import { KNOWLEDGE_FORMATS, KNOWLEDGE_ORIGIN_KINDS } from "@ff-pane/shared";
import type { IndexDbMigration } from "./migrations.js";

/** 知识库条目表（文档级，承载全部过滤维度）。 */
export const KNOWLEDGE_ENTRY_TABLE = "knowledge_entry";

/** 条目标签表（一行一标签，供精确过滤）。 */
export const KNOWLEDGE_TAG_TABLE = "knowledge_entry_tag";

/** 文本块影子内容表（external content；FTS5 与向量索引都挂在块上）。 */
export const KNOWLEDGE_CHUNK_TABLE = "knowledge_chunk";

/** 块的 FTS5 虚表。 */
export const KNOWLEDGE_FTS_TABLE = "knowledge_fts";

/** 向量后端状态表（单行；记录后端类型、维度与嵌入模型）。 */
export const KNOWLEDGE_VECTOR_STATE_TABLE = "knowledge_vector_state";

/** sqlite-vec 可用时的向量虚表（vec0）。 */
export const KNOWLEDGE_VEC0_TABLE = "knowledge_vec0";

/** sqlite-vec 不可用时的退路向量表（普通表 + JS 余弦，风险 R2 的兜底）。 */
export const KNOWLEDGE_VECTOR_FALLBACK_TABLE = "knowledge_vector";

/** 由 as const 常量数组生成 SQL 字面量列表（CHECK 约束与领域类型永不脱节）。 */
function sqlLiteralList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

const KNOWLEDGE_SCHEMA_V2 = `
CREATE TABLE ${KNOWLEDGE_ENTRY_TABLE} (
  -- 同 v1：显式 INTEGER PRIMARY KEY 别名 rowid，保证 rowid 稳定
  entry_rowid       INTEGER PRIMARY KEY,
  id                TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  format            TEXT NOT NULL CHECK (format IN (${sqlLiteralList(KNOWLEDGE_FORMATS)})),
  origin_kind       TEXT NOT NULL CHECK (origin_kind IN (${sqlLiteralList(KNOWLEDGE_ORIGIN_KINDS)})),
  -- file_import 的导入原路径（§8.3.2 保留目录结构）；已归一为正斜杠，供前缀过滤
  origin_path       TEXT,
  -- session_capture 的来源会话
  origin_session_id TEXT,
  -- §8.3.2 增量索引依据：内容哈希不变即跳过重新索引
  content_hash      TEXT NOT NULL,
  imported_at       INTEGER NOT NULL
);

CREATE INDEX idx_${KNOWLEDGE_ENTRY_TABLE}_format ON ${KNOWLEDGE_ENTRY_TABLE}(format);
CREATE INDEX idx_${KNOWLEDGE_ENTRY_TABLE}_imported_at ON ${KNOWLEDGE_ENTRY_TABLE}(imported_at);
-- 来源目录过滤是「路径前缀」语义，前缀 LIKE 能走本索引
CREATE INDEX idx_${KNOWLEDGE_ENTRY_TABLE}_origin_path ON ${KNOWLEDGE_ENTRY_TABLE}(origin_path);
CREATE INDEX idx_${KNOWLEDGE_ENTRY_TABLE}_content_hash ON ${KNOWLEDGE_ENTRY_TABLE}(content_hash);

CREATE TABLE ${KNOWLEDGE_TAG_TABLE} (
  entry_rowid INTEGER NOT NULL
    REFERENCES ${KNOWLEDGE_ENTRY_TABLE}(entry_rowid) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (entry_rowid, tag)
) WITHOUT ROWID;

-- 反向索引：按标签找条目（过滤方向），与主键的正向不同
CREATE INDEX idx_${KNOWLEDGE_TAG_TABLE}_tag ON ${KNOWLEDGE_TAG_TABLE}(tag);

CREATE TABLE ${KNOWLEDGE_CHUNK_TABLE} (
  chunk_rowid  INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  entry_rowid  INTEGER NOT NULL
    REFERENCES ${KNOWLEDGE_ENTRY_TABLE}(entry_rowid) ON DELETE CASCADE,
  -- 块在条目内的序号（从 0 起）。上下文扩展（§8.3.4）按相邻序号取块
  seq          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  -- ChunkProvenance（§8.3.4）：出处文件路径 / 标题层级路径（JSON 数组） / PDF 页码
  file_path    TEXT NOT NULL,
  heading_path TEXT,
  page         INTEGER,
  UNIQUE (entry_rowid, seq)
);

-- 上下文扩展按 (entry_rowid, seq) 区间取块，由上面的 UNIQUE 索引直接服务

CREATE VIRTUAL TABLE ${KNOWLEDGE_FTS_TABLE} USING fts5(
  text,
  -- 标题路径单列参与分词：小节标题是强主题信号，权重高于正文（见 knowledge-search 的 BM25 权重）
  heading,
  content='${KNOWLEDGE_CHUNK_TABLE}',
  content_rowid='chunk_rowid',
  tokenize='trigram'
);

-- 三只触发器保持影子表与虚表同步（同 v1）：
-- heading 列取 heading_path 的 JSON 原文即可——trigram 分词下 ["安装","Windows"]
-- 与 安装 Windows 的子串命中效果一致，多出的方括号引号不产生可检索的中文/英文子串。
CREATE TRIGGER ${KNOWLEDGE_CHUNK_TABLE}_ai AFTER INSERT ON ${KNOWLEDGE_CHUNK_TABLE} BEGIN
  INSERT INTO ${KNOWLEDGE_FTS_TABLE}(rowid, text, heading)
  VALUES (new.chunk_rowid, new.text, COALESCE(new.heading_path, ''));
END;

CREATE TRIGGER ${KNOWLEDGE_CHUNK_TABLE}_ad AFTER DELETE ON ${KNOWLEDGE_CHUNK_TABLE} BEGIN
  INSERT INTO ${KNOWLEDGE_FTS_TABLE}(${KNOWLEDGE_FTS_TABLE}, rowid, text, heading)
  VALUES ('delete', old.chunk_rowid, old.text, COALESCE(old.heading_path, ''));
END;

CREATE TRIGGER ${KNOWLEDGE_CHUNK_TABLE}_au AFTER UPDATE ON ${KNOWLEDGE_CHUNK_TABLE} BEGIN
  INSERT INTO ${KNOWLEDGE_FTS_TABLE}(${KNOWLEDGE_FTS_TABLE}, rowid, text, heading)
  VALUES ('delete', old.chunk_rowid, old.text, COALESCE(old.heading_path, ''));
  INSERT INTO ${KNOWLEDGE_FTS_TABLE}(rowid, text, heading)
  VALUES (new.chunk_rowid, new.text, COALESCE(new.heading_path, ''));
END;

CREATE TABLE ${KNOWLEDGE_VECTOR_STATE_TABLE} (
  -- 单行表：CHECK 把主键钉死在 1，多写一行即报错，不必靠约定维持「只有一行」
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  -- 'vec0' | 'fallback'，见 knowledge-vector.ts
  backend    TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  -- 建索引时用的嵌入模型：换模型必须重建，读回时用于提示
  model      TEXT NOT NULL
);
`;

/**
 * 迁移 v2：知识库索引（条目 / 标签 / 块 / FTS5 / 向量状态）。
 * 追加到 INDEX_DB_MIGRATIONS 末尾（见 schema.ts）。
 */
export const KNOWLEDGE_MIGRATION_V2: IndexDbMigration = {
  toVersion: 2,
  description: "知识库索引：条目 + 标签 + 块影子表 + FTS5 trigram 虚表 + 向量后端状态表",
  up: (db) => {
    db.exec(KNOWLEDGE_SCHEMA_V2);
  },
};
