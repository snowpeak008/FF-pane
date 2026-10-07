/**
 * Provider：模型来源配置（T10.3 模板填表化）。
 * 密钥红线（§4.3）：本文件只出现 ApiKeyRef 引用，密钥本体永不进入任何领域类型。
 */

import type { ApiKeyRef, EpochMillis, ModelId, ProviderId } from "./common.js";
import { createLiteralGuard } from "./common.js";

/** 内置 Provider 模板 ID（模板即数据，见 provider-templates.ts）。 */
export const PROVIDER_TEMPLATE_IDS = [
  "anthropic-official",
  "anthropic-compatible",
  "openai-official",
  "openai-compatible",
  "grok-compatible",
  "deepseek",
  "local-login",
] as const;

/** Provider 模板 ID。 */
export type ProviderTemplateId = (typeof PROVIDER_TEMPLATE_IDS)[number];

/** ProviderTemplateId 运行时守卫。 */
export const isProviderTemplateId = createLiteralGuard(PROVIDER_TEMPLATE_IDS);

/**
 * 旧版 providers.json（version 1）的 type 字面量。
 * 仅迁移与历史文档引用；新代码以 templateId 为准。
 */
export const LEGACY_PROVIDER_TYPES = [
  "openai_compatible",
  "anthropic",
  "cli_login",
  "custom",
] as const;

/** 旧版 Provider type。 */
export type LegacyProviderType = (typeof LEGACY_PROVIDER_TYPES)[number];

/** LegacyProviderType 运行时守卫。 */
export const isLegacyProviderType = createLiteralGuard(LEGACY_PROVIDER_TYPES);

/**
 * @deprecated T10.3 起用 ProviderTemplateId；保留别名以免外部瞬间炸裂。
 * 新代码请用 ProviderTemplateId / isProviderTemplateId。
 */
export type ProviderType = ProviderTemplateId | LegacyProviderType;

/** @deprecated 见 ProviderType。 */
export const PROVIDER_TYPES = PROVIDER_TEMPLATE_IDS;

/** @deprecated 见 isProviderTemplateId；同时接受旧 type（迁移期）。 */
export function isProviderType(value: unknown): value is ProviderType {
  return isProviderTemplateId(value) || isLegacyProviderType(value);
}

/** 模型用途：对话 / 嵌入（知识库 RAG）。 */
export const MODEL_KINDS = ["chat", "embedding"] as const;

/** 模型用途。 */
export type ModelKind = (typeof MODEL_KINDS)[number];

/** ModelKind 运行时守卫。 */
export const isModelKind = createLiteralGuard(MODEL_KINDS);

/** 探测超时缺省（秒）。 */
export const PROVIDER_DEFAULT_TIMEOUT_S = 120;

/** Anthropic 官方 API 根地址（迁移 anthropic→official 判定用）。 */
export const ANTHROPIC_OFFICIAL_BASE_URL = "https://api.anthropic.com";

/** OpenAI 官方 API 根地址。 */
export const OPENAI_OFFICIAL_BASE_URL = "https://api.openai.com/v1";

/**
 * DeepSeek 给 Claude Code 用的 Anthropic 兼容地址。
 * 来源：https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
 */
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

/** Provider 模型列表条目。 */
export interface ProviderModel {
  /** 模型 ID（Provider 方定义）。 */
  readonly id: ModelId;
  /** 显示名；缺省时 UI 回退到 id。 */
  readonly label?: string;
  /** 上下文窗口（token）；缺省由 Runtime/模型目录推断。 */
  readonly contextWindowTokens?: number;
  /**
   * 用途。缺省视为 chat。
   * 产品决策：保留 kind 以支持嵌入模型与 RAG（任务 schema 未列，但知识库依赖）。
   */
  readonly kind?: ModelKind;
}

/**
 * Provider 数据结构（T10.3，providers.json version 2）。
 *
 * 产品决策（相对任务裸 schema 的最小增补，见报告）：
 * - `enabled`：列表停用 / RAG 门槛仍需要；
 * - `embeddingModel` + model.kind：知识库嵌入仍需要；
 * - `timeoutS`：探测与嵌入超时仍需要。
 */
export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  /** 选用的内置模板。 */
  readonly templateId: ProviderTemplateId;
  readonly baseUrl?: string;
  readonly apiKeyRef?: ApiKeyRef;
  readonly models: readonly ProviderModel[];
  /** 默认对话模型（引用 models 中 chat 条目）。 */
  readonly defaultModelId?: ModelId;
  /** 默认嵌入模型（知识库 RAG）。 */
  readonly embeddingModel?: ModelId;
  readonly proxy?: string;
  /** 非密钥附加环境变量（解析器合并；不得覆盖密钥变量 / 危险变量）。 */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** 模板声明的可选项取值（如 authHeaderStyle）。 */
  readonly options?: Readonly<Record<string, string>>;
  readonly timeoutS?: number;
  readonly enabled: boolean;
  /** 创建时间；缺省由 store 在落盘时补齐。 */
  readonly createdAt?: EpochMillis;
  /** 最近修改时间；缺省由 store 在落盘时补齐。 */
  readonly updatedAt?: EpochMillis;
}

/**
 * 禁止出现在 extraEnv 中的危险变量（大小写不敏感）。
 * 落盘校验与注入解析共用同一名单。
 */
export const DANGEROUS_EXTRA_ENV_NAMES = [
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "PSMODULEPATH",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
] as const;

const DANGEROUS_EXTRA_ENV_SET = new Set(
  DANGEROUS_EXTRA_ENV_NAMES.map((name) => name.toLowerCase()),
);

/** 判断 extraEnv 键是否为危险变量。 */
export function isDangerousExtraEnvName(name: string): boolean {
  return DANGEROUS_EXTRA_ENV_SET.has(name.trim().toLowerCase());
}

/** 模型显示名：label → id。 */
export function providerModelLabel(model: ProviderModel): string {
  const label = model.label?.trim();
  return label !== undefined && label.length > 0 ? label : model.id;
}

/** 模型用途：缺省 chat。 */
export function providerModelKind(model: ProviderModel): ModelKind {
  return model.kind ?? "chat";
}

/** 是否为本机 CLI 登录模板（不注入密钥/地址）。 */
export function isLocalLoginProvider(provider: Pick<Provider, "templateId">): boolean {
  return provider.templateId === "local-login";
}

/** 该模板是否可能携带 API 密钥（local-login 除外）。 */
export function providerTemplateNeedsApiKey(templateId: ProviderTemplateId): boolean {
  return templateId !== "local-login";
}

/** OpenAI 族模板（可做 /embeddings）。 */
export function isOpenAiFamilyTemplate(templateId: ProviderTemplateId): boolean {
  return templateId === "openai-official" || templateId === "openai-compatible";
}

/** Anthropic 族模板。 */
export function isAnthropicFamilyTemplate(templateId: ProviderTemplateId): boolean {
  return templateId === "anthropic-official" || templateId === "anthropic-compatible";
}
