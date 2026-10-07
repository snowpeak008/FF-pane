/**
 * Provider → CLI 注入映射表（T10.3）：纯数据 + 通用占位符解析。
 * 新增模板：在 TEMPLATES 加一条 + 在本表加 (templateId, cli) 行；不改 switch。
 */

import type { Provider, ProviderTemplateCli, ProviderTemplateId } from "@ff-pane/shared";
import {
  getProviderTemplate,
  isDangerousExtraEnvName,
  isLocalLoginProvider,
  resolveTemplateOption,
} from "@ff-pane/shared";

/** 解析器输出：环境变量 + CLI configOverrides（如 Codex `-c`）。 */
export interface ProviderInjection {
  readonly env: Readonly<Record<string, string>>;
  readonly configOverrides: Readonly<Record<string, string>>;
  /** 本轮解析器占用的密钥环境变量名（extraEnv 不得覆盖）。 */
  readonly secretEnvKeys: readonly string[];
}

/** resolveProviderInjection 入参。 */
export interface ResolveProviderInjectionInput {
  readonly provider: Provider;
  readonly cli: ProviderTemplateCli;
  readonly model?: string;
  readonly secret?: string;
  /** Codex model_provider 槽名；缺省 `ffpane`。 */
  readonly providerSlug?: string;
}

/** @deprecated 请用 @ff-pane/shared 的同名常量；此处再导出以保持旧 import。 */
export { DANGEROUS_EXTRA_ENV_NAMES, isDangerousExtraEnvName } from "@ff-pane/shared";

export const DEFAULT_CODEX_PROVIDER_SLUG = "ffpane";
export const CLAUDE_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const CLAUDE_API_KEY_ENV = "ANTHROPIC_API_KEY";
export const CLAUDE_BASE_URL_ENV = "ANTHROPIC_BASE_URL";
export const CLAUDE_MODEL_ENV = "ANTHROPIC_MODEL";
export const CODEX_API_KEY_ENV = "OPENAI_API_KEY";
export const GROK_API_KEY_ENV = "XAI_API_KEY";
/** 中转推理地址。本机 grok 1.0.13 把聊天和模型列表都发到这个变量。 */
export const GROK_MODELS_BASE_URL_ENV = "GROK_MODELS_BASE_URL";

export class ProviderInjectionError extends Error {
  readonly code:
    | "unsupported-cli"
    | "missing-base-url"
    | "dangerous-extra-env"
    | "unknown-template"
    | "missing-mapping";

  constructor(code: ProviderInjectionError["code"], message: string) {
    super(message);
    this.name = "ProviderInjectionError";
    this.code = code;
  }
}

/** 单条 env / override 的值：字面量或占位符。 */
export type InjectionValueExpr =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "placeholder"; readonly name: PlaceholderName }
  | {
      readonly kind: "json-placeholder";
      readonly name: PlaceholderName;
    };

export type PlaceholderName =
  | "baseUrl"
  | "apiKey"
  | "model"
  | "providerSlug"
  | "providerName"
  | "apiKeyEnvName";

/** 一条注入映射（某 templateId × cli）。 */
export interface ProviderInjectionMapping {
  readonly templateId: ProviderTemplateId;
  readonly cli: ProviderTemplateCli;
  /** baseUrl 是否必填才能完成注入（官方模板可缺省）。 */
  readonly requireBaseUrl: boolean;
  /** 密钥写入的环境变量名（可被 authHeaderStyle 覆盖，见 resolveApiKeyEnvName）。 */
  readonly apiKeyEnv: string;
  readonly env: Readonly<Record<string, InjectionValueExpr>>;
  readonly configOverrides: Readonly<Record<string, InjectionValueExpr>>;
}

/**
 * 注入映射表。
 * 产品决策：openai-* 也对 claude-code 提供 ANTHROPIC_* 映射，
 * 以保持旧 openai_compatible + Claude 中转行为等价。
 * Codex：与旧流程一致，不写 wire_api（现行缺省 responses；chat 已移除）。
 */
export const PROVIDER_INJECTION_MAPPINGS: readonly ProviderInjectionMapping[] = [
  // —— Claude Code × Anthropic ——
  {
    templateId: "anthropic-official",
    cli: "claude-code",
    requireBaseUrl: false,
    apiKeyEnv: CLAUDE_API_KEY_ENV,
    env: {
      [CLAUDE_API_KEY_ENV]: { kind: "placeholder", name: "apiKey" },
      [CLAUDE_BASE_URL_ENV]: { kind: "placeholder", name: "baseUrl" },
      [CLAUDE_MODEL_ENV]: { kind: "placeholder", name: "model" },
    },
    configOverrides: {},
  },
  {
    templateId: "anthropic-compatible",
    cli: "claude-code",
    requireBaseUrl: true,
    apiKeyEnv: CLAUDE_AUTH_TOKEN_ENV,
    env: {
      // apiKeyEnv 运行时按 options.authHeaderStyle 替换键名
      [CLAUDE_AUTH_TOKEN_ENV]: { kind: "placeholder", name: "apiKey" },
      [CLAUDE_BASE_URL_ENV]: { kind: "placeholder", name: "baseUrl" },
      [CLAUDE_MODEL_ENV]: { kind: "placeholder", name: "model" },
    },
    configOverrides: {},
  },
  // —— Claude Code × OpenAI 兼容（旧流程兼容）——
  {
    templateId: "openai-official",
    cli: "claude-code",
    requireBaseUrl: false,
    apiKeyEnv: CLAUDE_API_KEY_ENV,
    env: {
      [CLAUDE_API_KEY_ENV]: { kind: "placeholder", name: "apiKey" },
      [CLAUDE_BASE_URL_ENV]: { kind: "placeholder", name: "baseUrl" },
      [CLAUDE_MODEL_ENV]: { kind: "placeholder", name: "model" },
    },
    configOverrides: {},
  },
  {
    templateId: "openai-compatible",
    cli: "claude-code",
    requireBaseUrl: true,
    apiKeyEnv: CLAUDE_API_KEY_ENV,
    env: {
      [CLAUDE_API_KEY_ENV]: { kind: "placeholder", name: "apiKey" },
      [CLAUDE_BASE_URL_ENV]: { kind: "placeholder", name: "baseUrl" },
      [CLAUDE_MODEL_ENV]: { kind: "placeholder", name: "model" },
    },
    configOverrides: {},
  },
  // —— Codex × OpenAI ——
  {
    templateId: "openai-official",
    cli: "codex",
    requireBaseUrl: false,
    apiKeyEnv: CODEX_API_KEY_ENV,
    env: {
      [CODEX_API_KEY_ENV]: { kind: "placeholder", name: "apiKey" },
    },
    configOverrides: {
      // 仅当 baseUrl 有值时写入（见 applyMapping）
      model_provider: { kind: "placeholder", name: "providerSlug" },
      "model_providers.{providerSlug}.name": { kind: "json-placeholder", name: "providerName" },
      "model_providers.{providerSlug}.base_url": { kind: "json-placeholder", name: "baseUrl" },
      "model_providers.{providerSlug}.env_key": {
        kind: "json-placeholder",
        name: "apiKeyEnvName",
      },
    },
  },
  {
    templateId: "openai-compatible",
    cli: "codex",
    requireBaseUrl: true,
    apiKeyEnv: CODEX_API_KEY_ENV,
    env: {
      [CODEX_API_KEY_ENV]: { kind: "placeholder", name: "apiKey" },
    },
    configOverrides: {
      model_provider: { kind: "placeholder", name: "providerSlug" },
      "model_providers.{providerSlug}.name": { kind: "json-placeholder", name: "providerName" },
      "model_providers.{providerSlug}.base_url": { kind: "json-placeholder", name: "baseUrl" },
      "model_providers.{providerSlug}.env_key": {
        kind: "json-placeholder",
        name: "apiKeyEnvName",
      },
    },
  },
  // —— Grok × 兼容中转（地址 + 密钥只进本进程环境，不写 ~/.grok）——
  {
    templateId: "grok-compatible",
    cli: "grok",
    requireBaseUrl: true,
    apiKeyEnv: GROK_API_KEY_ENV,
    env: {
      [GROK_API_KEY_ENV]: { kind: "placeholder", name: "apiKey" },
      [GROK_MODELS_BASE_URL_ENV]: { kind: "placeholder", name: "baseUrl" },
    },
    configOverrides: {},
  },
  // —— local-login：空映射（显式登记，避免漏表）——
  {
    templateId: "local-login",
    cli: "claude-code",
    requireBaseUrl: false,
    apiKeyEnv: "",
    env: {},
    configOverrides: {},
  },
  {
    templateId: "local-login",
    cli: "codex",
    requireBaseUrl: false,
    apiKeyEnv: "",
    env: {},
    configOverrides: {},
  },
];

const MAPPING_INDEX = new Map<string, ProviderInjectionMapping>(
  PROVIDER_INJECTION_MAPPINGS.map((mapping) => [`${mapping.templateId}::${mapping.cli}`, mapping]),
);

export function getInjectionMapping(
  templateId: string,
  cli: ProviderTemplateCli,
): ProviderInjectionMapping | undefined {
  return MAPPING_INDEX.get(`${templateId}::${cli}`);
}

/**
 * 校验并过滤 extraEnv：拒危险变量；跳过与密钥变量同名的项。
 */
export function mergeExtraEnv(
  baseEnv: Readonly<Record<string, string>>,
  extraEnv: Readonly<Record<string, string>> | undefined,
  secretEnvKeys: ReadonlySet<string>,
): Record<string, string> {
  if (extraEnv === undefined) {
    return { ...baseEnv };
  }
  const merged: Record<string, string> = { ...baseEnv };
  for (const [rawName, value] of Object.entries(extraEnv)) {
    const name = rawName.trim();
    if (name.length === 0) {
      continue;
    }
    if (isDangerousExtraEnvName(name)) {
      throw new ProviderInjectionError("dangerous-extra-env", `extraEnv 禁止设置危险变量：${name}`);
    }
    if (secretEnvKeys.has(name)) {
      continue;
    }
    merged[name] = value;
  }
  return merged;
}

interface PlaceholderContext {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly providerSlug: string;
  readonly providerName: string;
  readonly apiKeyEnvName: string;
}

function lookupPlaceholder(name: PlaceholderName, ctx: PlaceholderContext): string | undefined {
  switch (name) {
    case "baseUrl":
      return ctx.baseUrl;
    case "apiKey":
      return ctx.apiKey;
    case "model":
      return ctx.model;
    case "providerSlug":
      return ctx.providerSlug;
    case "providerName":
      return ctx.providerName;
    case "apiKeyEnvName":
      return ctx.apiKeyEnvName;
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}

function expandKey(key: string, ctx: PlaceholderContext): string {
  return key.replaceAll("{providerSlug}", ctx.providerSlug);
}

function resolveExpr(expr: InjectionValueExpr, ctx: PlaceholderContext): string | undefined {
  if (expr.kind === "literal") {
    return expr.value;
  }
  const raw = lookupPlaceholder(expr.name, ctx);
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  return expr.kind === "json-placeholder" ? JSON.stringify(raw) : raw;
}

/** anthropic-compatible：按 options 选择 AUTH_TOKEN / API_KEY。 */
function resolveApiKeyEnvName(provider: Provider, mapping: ProviderInjectionMapping): string {
  if (provider.templateId !== "anthropic-compatible" || mapping.apiKeyEnv.length === 0) {
    return mapping.apiKeyEnv;
  }
  const style =
    resolveTemplateOption(provider.templateId, "authHeaderStyle", provider.options) ?? "auth_token";
  return style === "api_key" ? CLAUDE_API_KEY_ENV : CLAUDE_AUTH_TOKEN_ENV;
}

function applyMapping(
  mapping: ProviderInjectionMapping,
  provider: Provider,
  ctx: PlaceholderContext,
): ProviderInjection {
  const env: Record<string, string> = {};
  const configOverrides: Record<string, string> = {};
  const secretEnvKeys: string[] = [];
  const apiKeyEnvName = ctx.apiKeyEnvName;

  for (const [rawKey, expr] of Object.entries(mapping.env)) {
    // anthropic-compatible 的密钥键名按 auth 风格替换
    const key =
      expr.kind === "placeholder" && expr.name === "apiKey" && apiKeyEnvName.length > 0
        ? apiKeyEnvName
        : expandKey(rawKey, ctx);
    const value = resolveExpr(expr, ctx);
    if (value === undefined) {
      continue;
    }
    env[key] = value;
    if (expr.kind !== "literal" && expr.name === "apiKey") {
      secretEnvKeys.push(key);
    }
  }

  // Codex 自定义路由：无 baseUrl 时整组 configOverrides 不写（官方可只注密钥）
  const writeOverrides = ctx.baseUrl !== undefined && ctx.baseUrl.length > 0;
  if (writeOverrides) {
    for (const [rawKey, expr] of Object.entries(mapping.configOverrides)) {
      const key = expandKey(rawKey, ctx);
      const value = resolveExpr(expr, ctx);
      if (value === undefined) {
        continue;
      }
      configOverrides[key] = value;
    }
  }

  return {
    env: mergeExtraEnv(env, provider.extraEnv, new Set(secretEnvKeys)),
    configOverrides,
    secretEnvKeys,
  };
}

/**
 * 按模板 × CLI 解析注入结果。
 * 密钥只进 env；configOverrides 仅含非密钥配置（Codex env_key 指向变量名）。
 */
export function resolveProviderInjection(input: ResolveProviderInjectionInput): ProviderInjection {
  const { provider, cli } = input;
  const template = getProviderTemplate(provider.templateId);
  if (template === undefined) {
    throw new ProviderInjectionError(
      "unknown-template",
      `未知的 Provider 模板：${provider.templateId}`,
    );
  }

  const mapping = getInjectionMapping(provider.templateId, cli);
  if (mapping === undefined) {
    throw new ProviderInjectionError(
      "unsupported-cli",
      `模板 ${provider.templateId} 不适用于 CLI ${cli}`,
    );
  }

  if (isLocalLoginProvider(provider)) {
    return {
      env: mergeExtraEnv({}, provider.extraEnv, new Set()),
      configOverrides: {},
      secretEnvKeys: [],
    };
  }

  const baseUrl = provider.baseUrl?.trim();
  if (mapping.requireBaseUrl && (baseUrl === undefined || baseUrl.length === 0)) {
    throw new ProviderInjectionError(
      "missing-base-url",
      `模板 ${provider.templateId} 需要 baseUrl`,
    );
  }

  const slug =
    input.providerSlug?.trim() && input.providerSlug.trim().length > 0
      ? input.providerSlug.trim()
      : DEFAULT_CODEX_PROVIDER_SLUG;
  const apiKeyEnvName = resolveApiKeyEnvName(provider, mapping);
  const model = input.model?.trim();
  const secret = input.secret !== undefined && input.secret.length > 0 ? input.secret : undefined;

  const ctx: PlaceholderContext = {
    ...(baseUrl !== undefined && baseUrl.length > 0 ? { baseUrl } : {}),
    ...(secret !== undefined ? { apiKey: secret } : {}),
    ...(model !== undefined && model.length > 0 ? { model } : {}),
    providerSlug: slug,
    providerName: provider.name.trim().length > 0 ? provider.name.trim() : slug,
    apiKeyEnvName,
  };

  return applyMapping(mapping, provider, ctx);
}

/** 断言 configOverrides 不含明文密钥（单测 / 调用方自检）。 */
export function assertSecretNotInOverrides(
  injection: ProviderInjection,
  secret: string | undefined,
): void {
  if (secret === undefined || secret.length === 0) {
    return;
  }
  for (const value of Object.values(injection.configOverrides)) {
    if (value.includes(secret)) {
      throw new Error("密钥出现在 configOverrides 中（违反 §4.3）");
    }
  }
}
