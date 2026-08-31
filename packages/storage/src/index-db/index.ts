/**
 * SQLite 索引基座(W1.3a)+ 记忆同步钩子与业务检索 API(W1.3b)barrel。
 * 索引永远是派生数据(设计文档 §8.4):真实源为 Markdown,删库即可由
 * rebuildIndex / rebuildIndexFromStore 全量重建。
 * 宿主与 UI 一律用 W1.3b 的 searchMemory 与 syncEntry* 钩子,
 * W1.3a 原语只在需要绕过业务策略时直用。
 */

export {
  closeIndexDb,
  DEFAULT_BUSY_TIMEOUT_MS,
  type OpenIndexDbOptions,
  openIndexDb,
} from "./connection.js";
export {
  CHUNK_SELECT_COLUMNS,
  type ChunkDbRow,
  type ChunkRowidMapping,
  clearKnowledgeIndex,
  deleteKnowledgeEntry,
  findEntryByContentHash,
  findEntryRowid,
  getKnowledgeEntry,
  getKnowledgeStats,
  type KnowledgeChunkInput,
  type KnowledgeEntryRow,
  type KnowledgeStats,
  listEntryChunks,
  listKnowledgeEntries,
  replaceEntryChunks,
  toKnowledgeChunk,
  toProvenance,
  upsertKnowledgeEntry,
} from "./knowledge-index.js";
export {
  KNOWLEDGE_CHUNK_TABLE,
  KNOWLEDGE_ENTRY_TABLE,
  KNOWLEDGE_FTS_TABLE,
  KNOWLEDGE_MIGRATION_V2,
  KNOWLEDGE_TAG_TABLE,
  KNOWLEDGE_VEC0_TABLE,
  KNOWLEDGE_VECTOR_FALLBACK_TABLE,
  KNOWLEDGE_VECTOR_STATE_TABLE,
} from "./knowledge-schema.js";
export {
  collectCandidateRowids,
  DEFAULT_KNOWLEDGE_SEARCH_LIMIT,
  expandContext,
  KNOWLEDGE_FTS_MIN_QUERY_CODE_POINTS,
  type KnowledgeFilters,
  type KnowledgeMatchSource,
  type KnowledgeSearchHit,
  type KnowledgeSearchOptions,
  type KnowledgeSearchResult,
  quoteKnowledgeFtsLiteral,
  RECALL_MULTIPLIER,
  searchKnowledge,
} from "./knowledge-search.js";
export {
  cosineDistance,
  decodeVector,
  dropVectorIndex,
  type EnsureVectorIndexOptions,
  encodeVector,
  ensureVectorIndex,
  loadVectorExtension,
  openVectorIndex,
  readVectorState,
  VECTOR_BACKENDS,
  VECTOR_PREFILTER_MAX_CANDIDATES,
  type VectorBackend,
  type VectorExtensionLoad,
  type VectorIndex,
  type VectorIndexResult,
  type VectorNeighbor,
  type VectorSearchParams,
} from "./knowledge-vector.js";
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
  MEMORY_FTS_MIN_QUERY_CODE_POINTS,
  type MemoryHydrateIssue,
  type MemoryMatchKind,
  type MemorySearchBaseOptions,
  type MemorySearchHit,
  type MemorySearchOptions,
  type MemorySearchResult,
  searchMemory,
} from "./memory-search.js";
export {
  type RebuildIndexFromStoreResult,
  rebuildIndexFromStore,
  syncEntryDeleted,
  syncEntrySaved,
  syncEntryStatusChanged,
} from "./memory-sync.js";
export {
  type IndexDbMigration,
  IndexDbVersionError,
  readUserVersion,
  runMigrations,
} from "./migrations.js";
export { INDEX_DB_MIGRATIONS, MEMORY_CONTENT_TABLE, MEMORY_FTS_TABLE } from "./schema.js";
