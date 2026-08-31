/**
 * 检索层公共出口（T6.4）：双路召回的融合规则。
 * 索引与查询本身在 storage 的 knowledge-search.ts —— 本层不认识 SQLite。
 */

export {
  DEFAULT_RRF_K,
  type FusedHit,
  fuseByRrf,
  type RankedList,
  type RrfOptions,
} from "./rrf.js";
