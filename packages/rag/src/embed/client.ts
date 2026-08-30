/**
 * 嵌入客户端的公共骨架（T6.3 内部实现，不进 barrel）。
 *
 * openai 与 ollama 两种方言只差三件事：端点路径、请求体形状、响应体形状。
 * 其余（配置校验、空批短路、空文本拦截、超时、维度一致性把关）完全相同，
 * 故抽成一个由 EmbedderSpec 参数化的工厂——新增第三种方言只需再写一个 spec。
 */

import { PROVIDER_DEFAULT_TIMEOUT_S } from "@ff-pane/shared";
import {
  EmbedConfigError,
  EmbedDimensionError,
  EmbedInputError,
  EmbedResponseError,
} from "./errors.js";
import { postJson, requireHttpBaseUrl, resolveFetch } from "./http.js";
import {
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_MAX_BATCH_TOKENS,
  type Embedder,
  type EmbedderApi,
  type EmbedderConfig,
  type EmbeddingVector,
  type EmbedRequestOptions,
} from "./types.js";

/** 方言差异的全部内容：路径、请求体、响应体。 */
export interface EmbedderSpec {
  /** 方言标识（进 Embedder.api）。 */
  readonly api: EmbedderApi;
  /** 由归一后的 baseUrl 算出完整端点 URL。 */
  resolveUrl(baseUrl: string): string;
  /** 鉴权头。密钥只在这里出现（§4.3）。 */
  buildHeaders(apiKey: string | undefined): Record<string, string>;
  /** 请求体。 */
  buildBody(model: string, texts: readonly string[]): unknown;
  /** 从响应体取出向量数组；形状不符抛 EmbedResponseError。 */
  parseVectors(payload: unknown, expectedCount: number, label: string): readonly EmbeddingVector[];
}

/** 任意值 → 向量，逐元素校验为有限数。NaN/null 混进索引会让相似度静默失真，必须当场拒。 */
export function toEmbeddingVector(value: unknown, label: string): EmbeddingVector {
  if (!Array.isArray(value)) {
    throw new EmbedResponseError(`${label} 不是数组`);
  }
  if (value.length === 0) {
    throw new EmbedResponseError(`${label} 是空数组`);
  }
  const vector: number[] = new Array<number>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const element: unknown = value[index];
    if (typeof element !== "number" || !Number.isFinite(element)) {
      throw new EmbedResponseError(`${label} 第 ${index} 个元素不是有限数：${String(element)}`);
    }
    vector[index] = element;
  }
  return vector;
}

/** 判定是否为普通对象（响应体解构前的守卫）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 正整数配置项校验。 */
function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new EmbedConfigError(`${field} 必须是正整数，实际 ${value}`);
  }
  return value;
}

/**
 * 按 spec 造一个 Embedder。配置错误在**构造时**就抛，
 * 不留到第一次请求——导入一个文件夹前就该知道配置能不能用。
 */
export function createHttpEmbedder(config: EmbedderConfig, spec: EmbedderSpec): Embedder {
  const model = config.model.trim();
  if (model === "") {
    throw new EmbedConfigError("model 为空");
  }
  const url = spec.resolveUrl(requireHttpBaseUrl(config.baseUrl));
  const timeoutS = config.timeoutS ?? PROVIDER_DEFAULT_TIMEOUT_S;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    throw new EmbedConfigError(`timeoutS 必须是正数，实际 ${String(config.timeoutS)}`);
  }
  const maxBatchSize = requirePositiveInteger(
    config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    "maxBatchSize",
  );
  const maxBatchTokens = requirePositiveInteger(
    config.maxBatchTokens ?? DEFAULT_MAX_BATCH_TOKENS,
    "maxBatchTokens",
  );
  if (config.expectedDimensions !== undefined) {
    requirePositiveInteger(config.expectedDimensions, "expectedDimensions");
  }
  const headers = spec.buildHeaders(config.apiKey);
  const doFetch = resolveFetch(config.fetch);

  // 首个成功批次确定维度；此后每批都对齐它（配了 expectedDimensions 则从一开始就对齐）
  let dimensions = config.expectedDimensions;

  return {
    api: spec.api,
    model,
    maxBatchSize,
    maxBatchTokens,
    get dimensions(): number | undefined {
      return dimensions;
    },
    async embed(
      texts: readonly string[],
      options?: EmbedRequestOptions,
    ): Promise<readonly EmbeddingVector[]> {
      if (texts.length === 0) {
        return [];
      }
      texts.forEach((text, index) => {
        if (typeof text !== "string" || text.trim() === "") {
          throw new EmbedInputError(`第 ${index} 个文本为空或纯空白，无法嵌入`);
        }
      });

      const payload = await postJson({
        url,
        headers,
        body: spec.buildBody(model, texts),
        timeoutS,
        fetch: doFetch,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      const vectors = spec.parseVectors(payload, texts.length, `POST ${url}`);

      for (const vector of vectors) {
        if (dimensions === undefined) {
          dimensions = vector.length;
        } else if (vector.length !== dimensions) {
          throw new EmbedDimensionError(model, dimensions, vector.length);
        }
      }
      return vectors;
    },
  };
}
