/**
 * openai 方言嵌入客户端（T6.3，设计文档 §8.3.3「openai_compatible 的 /embeddings 端点」）。
 *
 * 请求：POST {baseUrl}/embeddings  `{ model, input: string[], encoding_format: "float" }`
 * 响应：`{ data: [{ index, embedding: number[] }] }`
 *
 * 两处刻意为之：
 * - baseUrl 不自动增删 /v1：用户填什么前缀就用什么前缀（与 W1.5c 的 provider-probe 同规矩，
 *   各家的版本段并不统一——api.deepseek.com/v1、localhost:11434/v1、某些自建网关根本没有）。
 * - 显式声明 encoding_format:"float"：OpenAI 官方在部分 SDK 路径下默认返回 base64 向量，
 *   点名要 float 才能保证拿到数字数组。
 */

import { createHttpEmbedder, type EmbedderSpec, isRecord, toEmbeddingVector } from "./client.js";
import { EmbedResponseError } from "./errors.js";
import { joinUrl } from "./http.js";
import type { Embedder, EmbedderConfig, EmbeddingVector } from "./types.js";

/**
 * 解析 `{ data: [{ index, embedding }] }`。
 * 条目按 index 归位而不是依赖数组顺序——规范允许乱序返回，
 * 一旦错位，块与向量就张冠李戴，且没有任何后续环节能发现。
 */
function parseOpenAiVectors(
  payload: unknown,
  expectedCount: number,
  label: string,
): readonly EmbeddingVector[] {
  const data = isRecord(payload) ? payload["data"] : undefined;
  if (!Array.isArray(data)) {
    throw new EmbedResponseError(`${label} 的响应缺少 data 数组`);
  }
  if (data.length !== expectedCount) {
    throw new EmbedResponseError(
      `${label} 的 data 有 ${data.length} 条，与请求的 ${expectedCount} 个文本不符`,
    );
  }

  const vectors = new Array<EmbeddingVector | undefined>(expectedCount);
  data.forEach((entry: unknown, position: number) => {
    if (!isRecord(entry)) {
      throw new EmbedResponseError(`${label} 的 data[${position}] 不是对象`);
    }
    // index 缺省时退回数组位置：部分自建网关不回填该字段
    const rawIndex: unknown = entry["index"];
    const index = rawIndex === undefined ? position : rawIndex;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expectedCount
    ) {
      throw new EmbedResponseError(
        `${label} 的 data[${position}].index 越界或非整数：${String(index)}`,
      );
    }
    if (vectors[index] !== undefined) {
      throw new EmbedResponseError(`${label} 的 data 中 index=${index} 重复`);
    }
    vectors[index] = toEmbeddingVector(
      entry["embedding"],
      `${label} 的 data[${position}].embedding`,
    );
  });

  return vectors.map((vector, index) => {
    if (vector === undefined) {
      throw new EmbedResponseError(`${label} 的 data 缺少 index=${index} 的条目`);
    }
    return vector;
  });
}

/** openai 方言的方言差异定义。 */
const OPENAI_SPEC: EmbedderSpec = {
  api: "openai",
  resolveUrl: (baseUrl) => joinUrl(baseUrl, "embeddings"),
  // key 缺省（如本地 Ollama 的 /v1 端点）就不带 Authorization，服务端自会给出原文
  buildHeaders: (apiKey) =>
    apiKey === undefined || apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` },
  buildBody: (model, texts) => ({ model, input: texts, encoding_format: "float" }),
  parseVectors: parseOpenAiVectors,
};

/** 造一个 openai 方言嵌入器（openai_compatible Provider 走这条）。 */
export function createOpenAiEmbedder(config: EmbedderConfig): Embedder {
  return createHttpEmbedder(config, OPENAI_SPEC);
}
