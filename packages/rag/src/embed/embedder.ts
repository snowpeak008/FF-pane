/**
 * 嵌入器工厂与「未配置即降级」的判定（T6.3）。
 *
 * 设计文档 §8.3.3 的硬要求：**未配置嵌入模型时，知识库降级为纯全文检索，
 * 功能完整可用**。这条要求落在类型上就是本文件的 `| undefined`：
 * resolveEmbedder / embedderConfigFromProvider 都可以正大光明地返回 undefined，
 * 调用方（T6.4 索引、T6.5 导入编排）被类型逼着写出「没有嵌入器时只建 FTS」那条分支。
 * 反过来说，本层**不提供**任何「假嵌入器 / 零向量嵌入器」——那会把降级
 * 从一个显式分支变成一堆无意义的零向量混进索引。
 */

import type { Provider } from "@ff-pane/shared";
import { createOllamaEmbedder } from "./ollama.js";
import { createOpenAiEmbedder } from "./openai.js";
import type { Embedder, EmbedderConfig } from "./types.js";

/** 按方言造嵌入器。配置非法即抛 EmbedConfigError（构造时，不留到第一次请求）。 */
export function createEmbedder(config: EmbedderConfig): Embedder {
  switch (config.api) {
    case "openai":
      return createOpenAiEmbedder(config);
    case "ollama":
      return createOllamaEmbedder(config);
    default: {
      // 穷尽性检查：EmbedderApi 新增成员时此处编译失败，逼迫补客户端
      const exhaustive: never = config.api;
      throw new Error(`未覆盖的嵌入端点方言: ${String(exhaustive)}`);
    }
  }
}

/** embedderConfigFromProvider 的注入项。 */
export interface ProviderEmbedderOptions {
  /** 明文 API key（由主进程从系统密钥库取出，§4.3；本层只把它放进请求头）。 */
  readonly apiKey?: string;
  /** 已建索引的向量维度，用于换模型时当场拦下（见 EmbedderConfig.expectedDimensions）。 */
  readonly expectedDimensions?: number;
  /** 注入式 fetch。 */
  readonly fetch?: EmbedderConfig["fetch"];
  /** 覆盖单批文本数上限。 */
  readonly maxBatchSize?: number;
  /** 覆盖单批 token 上限。 */
  readonly maxBatchTokens?: number;
}

/**
 * Provider → 嵌入配置。**不满足条件一律返回 undefined**（调用方据此走纯 FTS）：
 * - Provider 未启用；
 * - 未设 embeddingModel（§4.1 的可选字段，正是「没配嵌入模型」的表达）；
 * - 类型不是 openai_compatible —— anthropic 官方没有嵌入端点，
 *   cli_login 的凭证不对外暴露、custom 只有对话模板，三者都无从发起 /embeddings；
 * - 缺 baseUrl。
 *
 * 注意：本函数只产 api:"openai" 的配置。本地 Ollama 有两条路——
 * 配成 openai_compatible + baseUrl ".../v1"（走这里），
 * 或由调用方直接构造 `{ api:"ollama", baseUrl: OLLAMA_DEFAULT_BASE_URL, model }`（走原生端点）。
 */
export function embedderConfigFromProvider(
  provider: Provider,
  options: ProviderEmbedderOptions = {},
): EmbedderConfig | undefined {
  if (!provider.enabled) {
    return undefined;
  }
  if (provider.type !== "openai_compatible") {
    return undefined;
  }
  const model = provider.embeddingModel?.trim() ?? "";
  const baseUrl = provider.baseUrl?.trim() ?? "";
  if (model === "" || baseUrl === "") {
    return undefined;
  }

  // exactOptionalPropertyTypes 全开：可选字段用条件展开，不写 undefined
  return {
    api: "openai",
    baseUrl,
    model,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(provider.timeoutS === undefined ? {} : { timeoutS: provider.timeoutS }),
    ...(options.maxBatchSize === undefined ? {} : { maxBatchSize: options.maxBatchSize }),
    ...(options.maxBatchTokens === undefined ? {} : { maxBatchTokens: options.maxBatchTokens }),
    ...(options.expectedDimensions === undefined
      ? {}
      : { expectedDimensions: options.expectedDimensions }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
}

/**
 * 一步到位：Provider 能嵌入就给嵌入器，不能就给 undefined。
 * 导入编排（T6.5）的典型写法：
 *   const embedder = resolveProviderEmbedder(provider, { apiKey });
 *   if (embedder === undefined) { // 纯 FTS 索引，功能不缺失 }
 */
export function resolveProviderEmbedder(
  provider: Provider,
  options: ProviderEmbedderOptions = {},
): Embedder | undefined {
  const config = embedderConfigFromProvider(provider, options);
  return config === undefined ? undefined : createEmbedder(config);
}
