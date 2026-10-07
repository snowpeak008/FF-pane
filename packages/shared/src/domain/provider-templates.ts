/**
 * 内置 Provider 模板（T10.3）：纯数据，新增模板 = 加一条 + i18n。
 * 注入映射表在 @ff-pane/core 的 provider-injection；本文件只声明字段 / 探测 / 可选项。
 */

import { createLiteralGuard } from "./common.js";
import {
  ANTHROPIC_OFFICIAL_BASE_URL,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  OPENAI_OFFICIAL_BASE_URL,
  PROVIDER_TEMPLATE_IDS,
  type ProviderTemplateId,
} from "./provider.js";

/** 模板适用的 CLI。Grok 中转只用 grok-compatible。DeepSeek 只用 deepseek。 */
export const PROVIDER_TEMPLATE_CLIS = ["claude-code", "codex", "grok", "deepseek"] as const;

/** 模板适用 CLI。 */
export type ProviderTemplateCli = (typeof PROVIDER_TEMPLATE_CLIS)[number];

/** ProviderTemplateCli 运行时守卫。 */
export const isProviderTemplateCli = createLiteralGuard(PROVIDER_TEMPLATE_CLIS);

/** HTTP 探测风格（按模板声明分发，不再按旧 type switch）。 */
export const PROVIDER_PROBE_KINDS = ["anthropic", "openai", "none"] as const;

/** 探测风格。 */
export type ProviderProbeKind = (typeof PROVIDER_PROBE_KINDS)[number];

/** ProviderProbeKind 运行时守卫。 */
export const isProviderProbeKind = createLiteralGuard(PROVIDER_PROBE_KINDS);

/** 字段在表单中的出现要求。 */
export type ProviderFieldRequirement = "required" | "optional" | "hidden";

/** 模板可选项（下拉）。 */
export interface ProviderTemplateOptionDef {
  /** options 字典里的键。 */
  readonly key: string;
  /** i18n key（显示名）。 */
  readonly labelKey: string;
  /** 可选值。 */
  readonly values: readonly string[];
  /** 缺省值。 */
  readonly defaultValue: string;
  /** 各 value 的 i18n key 前缀；完整 key = `${valueLabelKeyPrefix}.${value}`。 */
  readonly valueLabelKeyPrefix: string;
}

/** 单条内置模板声明。 */
export interface ProviderTemplateDefinition {
  readonly id: ProviderTemplateId;
  /** 显示名 i18n key。 */
  readonly nameKey: string;
  /** 简述 i18n key（卡片副文案，含适用 CLI）。 */
  readonly descriptionKey: string;
  readonly applicableClis: readonly ProviderTemplateCli[];
  readonly fields: {
    readonly baseUrl: ProviderFieldRequirement;
    readonly apiKey: ProviderFieldRequirement;
    readonly models: ProviderFieldRequirement;
  };
  /** 缺省 baseUrl（官方模板预填；兼容中转留空）。 */
  readonly defaultBaseUrl?: string;
  readonly probe: ProviderProbeKind;
  readonly options?: readonly ProviderTemplateOptionDef[];
}

/** Anthropic 兼容中转的认证头风格。 */
export const ANTHROPIC_AUTH_STYLES = ["auth_token", "api_key"] as const;
export type AnthropicAuthStyle = (typeof ANTHROPIC_AUTH_STYLES)[number];
export const isAnthropicAuthStyle = createLiteralGuard(ANTHROPIC_AUTH_STYLES);

/**
 * Codex 现行只认 responses；缺省不写 wire_api（与旧流程一致）。
 * 不再提供 chat 可选项（现行 Codex 反序列化会直接报错）。
 */

/** 内置模板表（顺序 = UI 卡片顺序）。 */
export const BUILTIN_PROVIDER_TEMPLATES: readonly ProviderTemplateDefinition[] = [
  {
    id: "anthropic-official",
    nameKey: "settings.providers.template.anthropic-official.name",
    descriptionKey: "settings.providers.template.anthropic-official.description",
    applicableClis: ["claude-code"],
    fields: { baseUrl: "optional", apiKey: "required", models: "optional" },
    defaultBaseUrl: ANTHROPIC_OFFICIAL_BASE_URL,
    probe: "anthropic",
  },
  {
    id: "anthropic-compatible",
    nameKey: "settings.providers.template.anthropic-compatible.name",
    descriptionKey: "settings.providers.template.anthropic-compatible.description",
    applicableClis: ["claude-code"],
    fields: { baseUrl: "required", apiKey: "required", models: "optional" },
    probe: "anthropic",
    options: [
      {
        key: "authHeaderStyle",
        labelKey: "settings.providers.option.authHeaderStyle",
        values: ANTHROPIC_AUTH_STYLES,
        defaultValue: "auth_token",
        valueLabelKeyPrefix: "settings.providers.optionValue.authHeaderStyle",
      },
    ],
  },
  {
    id: "openai-official",
    nameKey: "settings.providers.template.openai-official.name",
    descriptionKey: "settings.providers.template.openai-official.description",
    applicableClis: ["codex", "claude-code"],
    fields: { baseUrl: "optional", apiKey: "required", models: "optional" },
    defaultBaseUrl: OPENAI_OFFICIAL_BASE_URL,
    probe: "openai",
  },
  {
    id: "openai-compatible",
    nameKey: "settings.providers.template.openai-compatible.name",
    descriptionKey: "settings.providers.template.openai-compatible.description",
    applicableClis: ["codex", "claude-code"],
    fields: { baseUrl: "required", apiKey: "required", models: "optional" },
    probe: "openai",
  },
  {
    id: "grok-compatible",
    nameKey: "settings.providers.template.grok-compatible.name",
    descriptionKey: "settings.providers.template.grok-compatible.description",
    applicableClis: ["grok"],
    fields: { baseUrl: "required", apiKey: "required", models: "optional" },
    probe: "openai",
  },
  {
    id: "deepseek",
    nameKey: "settings.providers.template.deepseek.name",
    descriptionKey: "settings.providers.template.deepseek.description",
    applicableClis: ["deepseek"],
    fields: { baseUrl: "optional", apiKey: "required", models: "optional" },
    defaultBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
    probe: "anthropic",
  },
  {
    id: "local-login",
    nameKey: "settings.providers.template.local-login.name",
    descriptionKey: "settings.providers.template.local-login.description",
    applicableClis: ["claude-code", "codex"],
    fields: { baseUrl: "hidden", apiKey: "hidden", models: "optional" },
    probe: "none",
  },
] as const;

const TEMPLATE_BY_ID: ReadonlyMap<ProviderTemplateId, ProviderTemplateDefinition> = new Map(
  BUILTIN_PROVIDER_TEMPLATES.map((template) => [template.id, template]),
);

/** 按 ID 取模板；未知 ID 返回 undefined。 */
export function getProviderTemplate(templateId: string): ProviderTemplateDefinition | undefined {
  if (!PROVIDER_TEMPLATE_IDS.includes(templateId as ProviderTemplateId)) {
    return undefined;
  }
  return TEMPLATE_BY_ID.get(templateId as ProviderTemplateId);
}

/** 取模板；未知则抛。 */
export function requireProviderTemplate(templateId: string): ProviderTemplateDefinition {
  const template = getProviderTemplate(templateId);
  if (template === undefined) {
    throw new Error(`未知的 Provider 模板：${templateId}`);
  }
  return template;
}

/** 模板声明的探测方式。 */
export function providerProbeKind(templateId: string): ProviderProbeKind {
  return getProviderTemplate(templateId)?.probe ?? "none";
}

/** 解析模板可选项：显式 options → 模板缺省。 */
export function resolveTemplateOption(
  templateId: string,
  optionKey: string,
  options: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const template = getProviderTemplate(templateId);
  const def = template?.options?.find((option) => option.key === optionKey);
  if (def === undefined) {
    return undefined;
  }
  const raw = options?.[optionKey]?.trim();
  if (raw !== undefined && raw.length > 0 && def.values.includes(raw)) {
    return raw;
  }
  return def.defaultValue;
}
