/**
 * 记忆向量索引 schema（T8.7 迁移 v3，照 T6.4 知识库款式）。
 *
 * 与 v2 同一条纪律：索引整体是派生数据（§8.4），真实源是 Markdown 条目文件，
 * 全部表可由「listEntries → 重灌 → 重嵌入」重建，迁移只做前向升级。
 *
 * 两处与知识库不同的决定：
 *
 * 1. **多一张 memory_embedding_state（条目文本哈希）**。知识库的检索单元是块，
 *    块不可变——内容变了走 replaceEntryChunks 整条换新 rowid，于是「rowid 有向量」
 *    就等于「向量有效」。记忆条目是**原地可变的**（upsert 保持 rowid、正文可改），
 *    只看向量存在性会让编辑过的条目带着旧语义的向量继续被召回。故按条目存一份
 *    嵌入文本哈希：upsert 时哈希变了即作废旧向量与状态行，回填按「无向量或哈希缺席」
 *    找差额——断点续传（工单点名的条目哈希语义）与「编辑后重嵌入」是同一段判定。
 *
 * 2. **向量表仍不在迁移里建**（同 v2 的理由）：vec0 虚表维度在 CREATE 时固定，
 *    而维度取决于用户配的嵌入模型，迁移执行时不知道。v3 只建状态两表，
 *    真正的向量表由 ensureMemoryVectorIndex 在首条向量到手时惰性创建。
 */

import type { IndexDbMigration } from "./migrations.js";

/** 记忆向量后端状态表（单行；后端类型、维度与嵌入模型）。 */
export const MEMORY_VECTOR_STATE_TABLE = "memory_vector_state";

/** 记忆条目嵌入状态表（条目 rowid → 已嵌入文本的哈希）。 */
export const MEMORY_EMBEDDING_STATE_TABLE = "memory_embedding_state";

/** sqlite-vec 可用时的记忆向量虚表（vec0）。 */
export const MEMORY_VEC0_TABLE = "memory_vec0";

/** sqlite-vec 不可用时的退路向量表（普通表 + JS 余弦，与知识库同一退路语义）。 */
export const MEMORY_VECTOR_FALLBACK_TABLE = "memory_vector";

const MEMORY_VECTOR_SCHEMA_V3 = `
CREATE TABLE ${MEMORY_VECTOR_STATE_TABLE} (
  -- 单行表：CHECK 把主键钉死在 1（同 knowledge_vector_state 款式）
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  -- 'vec0' | 'fallback'，见 knowledge-vector.ts 的 VectorBackend
  backend    TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  model      TEXT NOT NULL
);

CREATE TABLE ${MEMORY_EMBEDDING_STATE_TABLE} (
  -- 引用 v1 的影子表 memory_entry（表名是 v1 起的公开事实，见 schema.ts）。
  -- 条目行删除即连带清状态（外键已在连接层开启）；vec0 是虚表 CASCADE 管不到，
  -- 向量删除由 memory-index 的写入原语显式处理。
  entry_rowid INTEGER PRIMARY KEY
    REFERENCES memory_entry(entry_rowid) ON DELETE CASCADE,
  -- 已嵌入文本（标题+正文+标签的规范拼接，见 memory-vector.ts）的 sha256
  text_hash   TEXT NOT NULL
);
`;

/**
 * 迁移 v3：记忆向量索引状态（向量后端状态表 + 条目嵌入状态表）。
 * 追加到 INDEX_DB_MIGRATIONS 末尾（见 schema.ts）。旧库升级无损：只建新表，不动既有数据。
 */
export const MEMORY_VECTOR_MIGRATION_V3: IndexDbMigration = {
  toVersion: 3,
  description: "记忆向量索引：向量后端状态表 + 条目嵌入文本哈希状态表",
  up: (db) => {
    db.exec(MEMORY_VECTOR_SCHEMA_V3);
  },
};
