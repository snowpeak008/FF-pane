/** 分块层公共出口（T6.2）。管道下一步是 T6.3 嵌入，消费 ChunkDraft.text。 */

export {
  type ChunkDocumentOptions,
  chunkDocument,
  type KnowledgeChunkIdentity,
  segmentDocument,
  toKnowledgeChunks,
} from "./chunker.js";
export { segmentCode } from "./code.js";
export { segmentMarkdown } from "./markdown.js";
export { packSegments } from "./pack.js";
export { splitParagraphs, splitPlainText } from "./plain.js";
export { atomize, splitByTokens, takeHead, takeTail } from "./split.js";
export { estimateTokens, isWideCodePoint, sliceByTokenBudget } from "./tokens.js";
export {
  type ChunkDraft,
  type ChunkingParams,
  DEFAULT_CHUNKING_PARAMS,
  type Segment,
  type SegmentBoundary,
} from "./types.js";
