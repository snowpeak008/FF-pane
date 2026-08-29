/**
 * SQLite 索引基座(W1.3a)barrel。
 * 索引永远是派生数据(设计文档 §8.4):真实源为 Markdown,删库即可由
 * rebuildIndex 全量重建。W1.3b 的记忆同步钩子与业务检索 API 在此之上搭建。
 */

export {
  closeIndexDb,
  DEFAULT_BUSY_TIMEOUT_MS,
  type OpenIndexDbOptions,
  openIndexDb,
} from "./connection.js";
export {
  DEFAULT_SEARCH_LIMIT,
  deleteMemoryEntry,
  type MemoryIndexHit,
  type MemoryIndexSearchOptions,
  quoteFtsQueryLiteral,
  rebuildIndex,
  searchMemoryIndex,
  upsertMemoryEntry,
} from "./memory-index.js";
export {
  type IndexDbMigration,
  IndexDbVersionError,
  readUserVersion,
  runMigrations,
} from "./migrations.js";
export { INDEX_DB_MIGRATIONS, MEMORY_CONTENT_TABLE, MEMORY_FTS_TABLE } from "./schema.js";
