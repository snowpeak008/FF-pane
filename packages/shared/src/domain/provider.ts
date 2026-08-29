/**
 * Provider：模型来源配置（设计文档 §4）。
 * 密钥红线（§4.3）：本文件只出现 ApiKeyRef 引用，密钥本体永不进入任何领域类型。
 */

import type { ApiKeyRef, ModelId, ProviderId } from "./common.js";
import { createLiteralGuard } from "./common.js";

/** 设计文档 §4.2 —— 四种 Provider 类型。 */
export const PROVIDER_TYPES = ["openai_compatible", "anthropic", "cli_login", "custom"] as const;

/** 设计文档 §4.2 —— Provider 类型。 */
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** ProviderType 运行时守卫。 */
export const isProviderType = createLiteralGuard(PROVIDER_TYPES);

/** 设计文档 §4.1 —— 模型条目的用途：对话模型 / 嵌入模型（知识库 RAG，§8.3.3）。 */
export const MODEL_KINDS = ["chat", "embedding"] as const;

/** 设计文档 §4.1 —— 模型用途。 */
export type ModelKind = (typeof MODEL_KINDS)[number];

/** ModelKind 运行时守卫。 */
export const isModelKind = createLiteralGuard(MODEL_KINDS);

/** 设计文档 §4.1 —— timeout_s 缺省值（秒）。 */
export const PROVIDER_DEFAULT_TIMEOUT_S = 120;

/** 设计文档 §4.1 —— Provider 模型列表条目 `{ id, display_name, kind }`。 */
export interface ProviderModel {
  /** 设计文档 §4.1 —— 模型 ID（Provider 方定义，如 "deepseek-chat"）。 */
  readonly id: ModelId;
  /** 设计文档 §4.1 —— display_name 显示名。 */
  readonly displayName: string;
  /** 设计文档 §4.1 —— kind: chat | embedding。 */
  readonly kind: ModelKind;
}

/**
 * 设计文档 §4.1 —— Provider 数据结构。
 * 各类型的必填约束（§4.2）：openai_compatible / anthropic 需 baseUrl + apiKeyRef；
 * cli_login 两者皆无（凭证由 CLI 自管）；custom 按 requestTemplate 填写。
 * 该约束的校验属 W1.5a / W1.6，类型层保持扁平结构以贴合配置编辑界面。
 */
export interface Provider {
  /** 设计文档 §4.1 —— id 内部唯一 ID。 */
  readonly id: ProviderId;
  /** 设计文档 §4.1 —— name 显示名，用户自定义。 */
  readonly name: string;
  /** 设计文档 §4.1 / §4.2 —— type 四种 Provider 类型之一。 */
  readonly type: ProviderType;
  /** 设计文档 §4.1 —— base_url API 地址（cli_login 类型不需要）。 */
  readonly baseUrl?: string;
  /** 设计文档 §4.1 / §4.3 —— api_key_ref 密钥引用（本体在系统密钥库）。 */
  readonly apiKeyRef?: ApiKeyRef;
  /** 设计文档 §4.1 —— models 模型列表。 */
  readonly models: readonly ProviderModel[];
  /** 设计文档 §4.1 —— default_model 默认对话模型（引用 models 中 kind=chat 的条目）。 */
  readonly defaultModel?: ModelId;
  /** 设计文档 §4.1 —— embedding_model 可选默认嵌入模型（知识库 RAG 使用，§8.3）。 */
  readonly embeddingModel?: ModelId;
  /** 设计文档 §4.1 —— proxy 可选代理地址。 */
  readonly proxy?: string;
  /** 设计文档 §4.1 —— timeout_s 可选超时秒数，缺省 PROVIDER_DEFAULT_TIMEOUT_S。 */
  readonly timeoutS?: number;
  /** 设计文档 §4.2 —— custom 类型的自定义请求模板（其余类型不使用）。 */
  readonly requestTemplate?: string;
  /** 设计文档 §4.1 —— enabled 是否启用。 */
  readonly enabled: boolean;
}
