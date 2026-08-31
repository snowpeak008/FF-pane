/**
 * Provider 连接探测的公共类型（W1.5c，设计文档 §4.2）。
 * 本模块是纯网络探测逻辑：明文 API key 由调用方（主进程，经 W1.5b revealSecret）
 * 取出后作为参数传入、用完即弃——不依赖 Electron / secrets 模块，不做任何密钥存取。
 * 所有失败均以判别联合返回（不抛业务异常），供 IPC 层直接序列化转发。
 *
 * 下方 reference 指令：ProbeFetch 用到 Node 运行时全局（RequestInit / Response），
 * 而本包 tsconfig 未开 "types"，需显式引入 @types/node 的全局声明（同 http.ts）。
 */

/// <reference types="node" />

import type { ModelId, ProviderModel, ProviderType } from "@ff-pane/shared";

/**
 * 探测失败的阶段：
 * - unsupported：Provider 类型不支持 HTTP 探测（cli_login 凭证由 CLI 自管；
 *   custom 请求模板无法通用构造最小请求）。
 * - invalid-config：发请求前即可判定的配置问题（缺 baseUrl、URL 非法、
 *   anthropic 探测缺模型 ID 等），未发生网络请求。
 * - network：网络层失败（DNS、连接被拒、TLS……），rawError 为 cause 链原始 message。
 * - timeout：超过 timeoutS（缺省 PROVIDER_DEFAULT_TIMEOUT_S）未完成，AbortController 中止。
 * - http：收到非 2xx 响应，rawError 为 HTTP 状态 + 响应体原文（§4.2 不做友好化包装）。
 * - invalid-response：收到 2xx 但响应体无法按预期解析（仅 fetchModels 使用）。
 */
export type ProbeFailureStage =
  | "unsupported"
  | "invalid-config"
  | "network"
  | "timeout"
  | "http"
  | "invalid-response";

/** 探测失败结果：testConnection 与 fetchModels 共用的失败分支。 */
export interface ProbeFailure {
  readonly ok: false;
  /** 失败阶段，供上层分类展示（如超时与鉴权失败给出不同引导）。 */
  readonly stage: ProbeFailureStage;
  /**
   * 错误原文（§4.2：直接展示、不做"友好化"包装）。
   * 响应体仅做长度截断不改写；唯一例外是密钥红线——输出中的明文 key
   * 会被兜底替换为 REDACTED_KEY_PLACEHOLDER（见 raw-error.ts）。
   */
  readonly rawError: string;
}

/**
 * 探测所需的最小 Provider 字段子集。
 * 结构化子类型：完整 Provider 可直接传入；设置页（W3.2a）未保存的表单草稿
 * 同样满足此形状，先测连接再落盘的交互无需先建档。
 */
export interface ProbeProviderInput {
  readonly type: ProviderType;
  /** API 地址。openai_compatible 应自带版本段（如 https://api.deepseek.com/v1），见 url.ts。 */
  readonly baseUrl?: string;
  /** 超时秒数，缺省 PROVIDER_DEFAULT_TIMEOUT_S（120）。 */
  readonly timeoutS?: number;
  /** 默认对话模型：anthropic 探测与 openai chat 回退探测的缺省模型来源。 */
  readonly defaultModel?: ModelId;
}

/**
 * 探测请求实际使用的 fetch，缺省为运行时全局 fetch。
 *
 * 存在的理由是**网络出口由调用方决定**：Provider 的代理配置（Provider.proxy）
 * 要经 undici ProxyAgent 生效，而 undici 是 Electron 主进程侧的事——本包不认识
 * Electron、也不认识 undici（模块头的纪律），故只留这一个函数接缝，代理的构造与
 * 校验落在主进程（apps/desktop/src/main/provider-proxy.ts）。
 */
export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

/** fetchModels 入参。 */
export interface FetchModelsParams {
  readonly provider: ProbeProviderInput;
  /**
   * 明文 API key。仅用于构造请求头（Bearer / x-api-key），不进入 URL、
   * 请求体与任何返回值。openai_compatible 允许缺省（如本地 Ollama 无鉴权）。
   */
  readonly apiKey?: string;
  /** 自定义网络出口（如经代理）。缺省走全局 fetch，与不注入时逐字节同行为。 */
  readonly fetchImpl?: ProbeFetch;
}

/** testConnection 入参：在 fetchModels 基础上允许显式指定探测模型。 */
export interface TestConnectionParams extends FetchModelsParams {
  /** 显式指定探测用模型 ID，优先于 provider.defaultModel。 */
  readonly model?: ModelId;
}

/** 连接测试成功：耗时 + 人类可读的探测方式说明。 */
export interface ConnectionTestSuccess {
  readonly ok: true;
  /** 成功那次请求的往返耗时（毫秒，取整）。 */
  readonly latencyMs: number;
  /** 探测方式与结果说明（如 "GET …/models → HTTP 200"），供设置页展示。 */
  readonly detail: string;
}

/** 连接测试结果（设计文档 §4.2：成功 / 失败 + 错误原文）。 */
export type ConnectionTestResult = ConnectionTestSuccess | ProbeFailure;

/** 模型列表拉取成功。 */
export interface FetchModelsSuccess {
  readonly ok: true;
  /** 解析出的模型条目，kind 为初始推断值（见 model-kind.ts），允许上层修改。 */
  readonly models: readonly ProviderModel[];
}

/** 模型列表拉取结果。失败时上层走手动输入回退（§4.2），不做重试。 */
export type FetchModelsResult = FetchModelsSuccess | ProbeFailure;
