/**
 * 嵌入层公共出口（T6.3）。管道上一步是 T6.2 分块，下一步是 T6.4 向量索引与混合检索。
 * 内部实现（http.ts / client.ts）刻意不出口：它们是方言客户端的私有底座。
 */

export { type BatchPlanParams, planBatches } from "./batch.js";
export {
  createEmbedder,
  embedderConfigFromProvider,
  type ProviderEmbedderOptions,
  resolveProviderEmbedder,
} from "./embedder.js";
export {
  EMBED_ERROR_CODES,
  EmbedAbortedError,
  EmbedConfigError,
  EmbedDimensionError,
  EmbedError,
  type EmbedErrorCode,
  EmbedHttpError,
  EmbedInputError,
  EmbedNetworkError,
  EmbedResponseError,
  EmbedTimeoutError,
  isRetriableEmbedError,
} from "./errors.js";
export { embeddingFingerprint, hashText } from "./fingerprint.js";
export { createOllamaEmbedder, OLLAMA_DEFAULT_BASE_URL, ollamaApiRoot } from "./ollama.js";
export { createOpenAiEmbedder } from "./openai.js";
export {
  DEFAULT_EMBED_CONCURRENCY,
  DEFAULT_EMBED_RETRY,
  type EmbedBatchFailure,
  type EmbedChunksOptions,
  type EmbedChunksReport,
  type EmbeddableChunk,
  type EmbeddedChunk,
  type EmbedProgress,
  type EmbedRetryPolicy,
  embedChunks,
  isFatalEmbedError,
} from "./pipeline.js";
export {
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_MAX_BATCH_TOKENS,
  EMBEDDER_APIS,
  type Embedder,
  type EmbedderApi,
  type EmbedderConfig,
  type EmbeddingVector,
  type EmbedRequestOptions,
  type FetchLike,
} from "./types.js";
