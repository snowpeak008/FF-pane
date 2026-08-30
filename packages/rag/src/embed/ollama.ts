/**
 * ollama 方言嵌入客户端（T6.3，设计文档 §8.3.3「或本地 Ollama」）。
 *
 * 请求：POST {baseUrl}/api/embed  `{ model, input: string[] }`
 * 响应：`{ embeddings: number[][] }`（顺序与 input 一致）
 *
 * 为什么不直接走 Ollama 的 /v1 兼容端点（那样只需一个客户端）：
 * 原生 /api/embed 是 Ollama 0.3.5 起的官方批量接口，批量语义明确、无需鉴权头，
 * 且不受兼容层字段裁剪的影响。想走兼容端点的用户仍可配 api:"openai" +
 * baseUrl "http://localhost:11434/v1"，两条路都通。
 */

import { createHttpEmbedder, type EmbedderSpec, isRecord, toEmbeddingVector } from "./client.js";
import { EmbedResponseError } from "./errors.js";
import { joinUrl, normalizeBaseUrl } from "./http.js";
import type { Embedder, EmbedderConfig, EmbeddingVector } from "./types.js";

/** Ollama 默认服务地址（官方默认监听）。 */
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

/**
 * 去掉尾部的 /v1：原生 API 挂在服务根下，
 * 而用户十有八九是从 openai_compatible 配置里把带 /v1 的地址复制过来的。
 * 与其让他撞一个 404 再自己琢磨，不如在这里认下这个手误。
 */
export function ollamaApiRoot(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/i, "");
}

/** 解析 `{ embeddings: number[][] }`。顺序即 input 顺序，Ollama 不回 index 字段。 */
function parseOllamaVectors(
  payload: unknown,
  expectedCount: number,
  label: string,
): readonly EmbeddingVector[] {
  const embeddings = isRecord(payload) ? payload["embeddings"] : undefined;
  if (!Array.isArray(embeddings)) {
    throw new EmbedResponseError(`${label} 的响应缺少 embeddings 数组`);
  }
  if (embeddings.length !== expectedCount) {
    throw new EmbedResponseError(
      `${label} 的 embeddings 有 ${embeddings.length} 条，与请求的 ${expectedCount} 个文本不符`,
    );
  }
  return embeddings.map((entry: unknown, index: number) =>
    toEmbeddingVector(entry, `${label} 的 embeddings[${index}]`),
  );
}

/** ollama 方言的方言差异定义。 */
const OLLAMA_SPEC: EmbedderSpec = {
  api: "ollama",
  resolveUrl: (baseUrl) => joinUrl(ollamaApiRoot(baseUrl), "api/embed"),
  // 本地服务无鉴权；置于反代之后时仍支持 Bearer
  buildHeaders: (apiKey) =>
    apiKey === undefined || apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` },
  buildBody: (model, texts) => ({ model, input: texts }),
  parseVectors: parseOllamaVectors,
};

/** 造一个 ollama 方言嵌入器（本地 Ollama 走这条）。 */
export function createOllamaEmbedder(config: EmbedderConfig): Embedder {
  return createHttpEmbedder(config, OLLAMA_SPEC);
}
