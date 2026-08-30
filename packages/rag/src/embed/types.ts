/**
 * 嵌入层类型契约（T6.3，设计文档 §8.3.3「向量索引（嵌入模型生成）」）。
 *
 * 分工：
 * - Embedder 是**唯一**的对外抽象：文本进、向量出，一次一批。
 *   谁来实现（Provider 的 /embeddings、本地 Ollama、将来的别的什么）
 *   对分块层与索引层都不可见。
 * - 网络细节（超时、重试、鉴权头）压在实现内部；fetch 注入式传入，
 *   既便于单测打桩，也保证本包不碰 Electron（技术选型 §3 硬性规则）。
 * - **未配置嵌入模型是一等公民**：配置解析恒可返回 undefined，
 *   调用方据此走纯 FTS 路径（§8.3.3「向量检索是增强，不是前提」），
 *   而不是拿一个会抛异常的假 Embedder 硬撑。
 */

/// <reference types="node" />

/**
 * 嵌入向量。用 number[] 而非 Float32Array：它要经 JSON 边界（HTTP 响应）
 * 与存储边界（T6.4 落库）各走一趟，转 typed array 的收益在这两处都被抵消。
 */
export type EmbeddingVector = readonly number[];

/** 嵌入端点的协议方言。 */
export const EMBEDDER_APIS = ["openai", "ollama"] as const;

/**
 * 嵌入端点协议：
 * - openai —— POST {baseUrl}/embeddings，`{model, input[]}` → `{data:[{index,embedding}]}`。
 *   覆盖 OpenAI / DeepSeek / 硅基流动 / vLLM 等一切 openai_compatible 服务（§4.2），
 *   Ollama 的 /v1 兼容端点也走这一支。
 * - ollama —— POST {baseUrl}/api/embed，`{model, input[]}` → `{embeddings[][]}`（原生批量接口）。
 */
export type EmbedderApi = (typeof EMBEDDER_APIS)[number];

/**
 * 注入式 fetch：默认取全局 fetch，单测传入打桩实现。
 * 签名刻意收窄为「字符串 URL + RequestInit」——本层不需要 Request 对象形态。
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 嵌入器配置。除 api/baseUrl/model 外均有缺省值。 */
export interface EmbedderConfig {
  /** 端点协议方言。 */
  readonly api: EmbedderApi;
  /** 服务地址（http/https）。openai 方言下应自带版本段，如 https://api.openai.com/v1。 */
  readonly baseUrl: string;
  /** 嵌入模型 ID（如 "text-embedding-3-small"、"nomic-embed-text"）。 */
  readonly model: string;
  /** API key；本地 Ollama 等无鉴权服务缺省。密钥只进请求头（§4.3）。 */
  readonly apiKey?: string;
  /** 单请求超时秒数，缺省 PROVIDER_DEFAULT_TIMEOUT_S。 */
  readonly timeoutS?: number;
  /** 单批最多多少个文本，缺省 DEFAULT_MAX_BATCH_SIZE。 */
  readonly maxBatchSize?: number;
  /** 单批最多多少 token（估算值），缺省 DEFAULT_MAX_BATCH_TOKENS。 */
  readonly maxBatchTokens?: number;
  /**
   * 期望维度：已建索引的向量维度。设定后每批都校验，
   * 不符即抛 EmbedDimensionError——换了模型却复用旧索引，是必须当场拦下的事故
   * （维度不一致的向量混进同一张表，检索结果会静默地毫无意义）。
   * 注意：它**不会**作为请求参数发出（多数服务不认 dimensions 字段）。
   */
  readonly expectedDimensions?: number;
  /** 注入式 fetch，缺省取全局 fetch。 */
  readonly fetch?: FetchLike;
}

/** 单次嵌入请求的可选行为。 */
export interface EmbedRequestOptions {
  /** 取消信号：中止进行中的请求，抛 EmbedAbortedError。 */
  readonly signal?: AbortSignal;
}

/**
 * 嵌入器：本层唯一对外抽象。
 * 契约：embed 返回的向量与入参 texts **等长且同序**；任一文本为空串或纯空白即抛
 * EmbedInputError（空文本没有语义，不该占一个索引位）。
 */
export interface Embedder {
  /** 端点协议方言。 */
  readonly api: EmbedderApi;
  /** 嵌入模型 ID。 */
  readonly model: string;
  /** 单批文本数上限（调度层据此切批）。 */
  readonly maxBatchSize: number;
  /** 单批 token 上限（调度层据此切批）。 */
  readonly maxBatchTokens: number;
  /** 已观测到的向量维度；首次成功返回前为 undefined（配置了 expectedDimensions 则一开始就有值）。 */
  readonly dimensions: number | undefined;
  /** 嵌入一批文本。空数组直接返回空数组，不发请求。 */
  embed(
    texts: readonly string[],
    options?: EmbedRequestOptions,
  ): Promise<readonly EmbeddingVector[]>;
}

/** 单批文本数缺省上限：兼顾远端吞吐与本地 Ollama 的单机负载。 */
export const DEFAULT_MAX_BATCH_SIZE = 32;

/**
 * 单批 token 缺省上限（估算 token）。
 * 按 T6.2 的 800 token 块上限算，一批约 10 块——既摊薄了 HTTP 往返开销，
 * 又不至于撞上各家服务对「单请求总 token」的限制。
 */
export const DEFAULT_MAX_BATCH_TOKENS = 8000;
