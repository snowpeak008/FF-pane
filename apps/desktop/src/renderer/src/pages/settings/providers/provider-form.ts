/**
 * Provider 编辑表单的纯逻辑（W3.2a）：类型 → 字段可见性、既有 Provider → 表单态、
 * 表单态 → 线上草稿。无 React / DOM 依赖，可直接单测（见 tests/provider-form.test.ts）。
 *
 * 校验的权威在 storage 层 validateProviderDraft（create/update 时强制执行）；
 * 本层只做"构造草稿 + 决定字段显隐"，不复制后端校验规则（避免两处漂移）。
 */

import type { ModelKind, Provider, ProviderType } from "@ff-pane/shared";
import type { ProviderDraftWire } from "../../../../../shared-ipc/contracts";

/** 类型下拉的展示顺序（cli_login 无需网络配置，custom 高阶，排后）。 */
export const PROVIDER_TYPE_ORDER: readonly ProviderType[] = [
  "openai_compatible",
  "anthropic",
  "cli_login",
  "custom",
];

/** 该类型是否需要 baseUrl（openai/anthropic 必填；custom 选填；cli_login 不用）。 */
export function usesBaseUrl(type: ProviderType): boolean {
  return type === "openai_compatible" || type === "anthropic" || type === "custom";
}

/** 该类型是否经手 API 密钥（cli_login 凭证由 CLI 自管；custom 走模板，不在此收密钥）。 */
export function usesApiKey(type: ProviderType): boolean {
  return type === "openai_compatible" || type === "anthropic";
}

/**
 * 该类型是否谈得上代理出口。与 usesBaseUrl 同域且刻意共用判定：代理是"这条 HTTP
 * 出口怎么走"的问题，没有 baseUrl 的 cli_login 由 CLI 自管端点与网络，
 * 其代理走用户 shell 的环境变量，工作台不代管。
 */
export function usesProxy(type: ProviderType): boolean {
  return usesBaseUrl(type);
}

/** 该类型是否需要 requestTemplate（仅 custom）。 */
export function usesRequestTemplate(type: ProviderType): boolean {
  return type === "custom";
}

/** 是否支持 HTTP 探测（cli_login / custom 不支持，见 provider-probe types）。 */
export function supportsProbe(type: ProviderType): boolean {
  return type === "openai_compatible" || type === "anthropic";
}

/** 编辑表单里的单个模型行（均为字符串态，提交时裁剪）。 */
export interface ModelRow {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ModelKind;
}

/** 编辑表单的完整状态（全字符串 / 布尔，贴合受控输入）。 */
export interface ProviderFormState {
  readonly name: string;
  readonly type: ProviderType;
  readonly baseUrl: string;
  readonly models: readonly ModelRow[];
  readonly defaultModel: string;
  readonly embeddingModel: string;
  /** 代理地址（§4.1 proxy），空串即直连。 */
  readonly proxy: string;
  readonly timeoutS: string;
  readonly requestTemplate: string;
  readonly enabled: boolean;
}

/** 空表单（新建默认：openai_compatible、启用、无模型）。 */
export function emptyProviderForm(): ProviderFormState {
  return {
    name: "",
    type: "openai_compatible",
    baseUrl: "",
    models: [],
    defaultModel: "",
    embeddingModel: "",
    proxy: "",
    timeoutS: "",
    requestTemplate: "",
    enabled: true,
  };
}

/**
 * 既有 Provider → 编辑表单态（读入侧）。与 buildProviderDraft（写出侧）成对，
 * 两者必须闭合：读进来的可选字段若在此漏掉，用户编辑一次就会被 providers:update
 * 的整表单替换语义静默抹掉（proxy 曾经就是这样丢值的）。
 * apiKeyRef 刻意不进表单：密钥只以尾 4 位占位显示，明文永不回渲染层（§4.3）。
 */
export function formFromProvider(provider: Provider): ProviderFormState {
  return {
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl ?? "",
    models: provider.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      kind: model.kind,
    })),
    defaultModel: provider.defaultModel ?? "",
    embeddingModel: provider.embeddingModel ?? "",
    proxy: provider.proxy ?? "",
    timeoutS: provider.timeoutS !== undefined ? String(provider.timeoutS) : "",
    requestTemplate: provider.requestTemplate ?? "",
    enabled: provider.enabled,
  };
}

/** 裁剪后的有效模型行（id 非空），按类型分组供下拉使用。 */
export function cleanModels(models: readonly ModelRow[]): readonly ModelRow[] {
  return models
    .map((row) => ({ ...row, id: row.id.trim(), displayName: row.displayName.trim() }))
    .filter((row) => row.id.length > 0);
}

/**
 * 表单态 → 线上草稿（ProviderDraftWire）。
 * exactOptionalPropertyTypes：可选字段一律"有值才带"，空串 / 空数组视为未设置并省略。
 * apiKeyRef 不由本层构造——密钥经明文 apiKey 交主进程加密（§4.3）。
 */
export function buildProviderDraft(form: ProviderFormState): ProviderDraftWire {
  const models = cleanModels(form.models).map((row) => ({
    id: row.id,
    displayName: row.displayName.length > 0 ? row.displayName : row.id,
    kind: row.kind,
  }));
  const modelIds = new Set(models.map((model) => model.id));
  const baseUrl = form.baseUrl.trim();
  const defaultModel = form.defaultModel.trim();
  const embeddingModel = form.embeddingModel.trim();
  const proxy = form.proxy.trim();
  const timeoutRaw = form.timeoutS.trim();
  const timeoutS = timeoutRaw.length > 0 ? Number(timeoutRaw) : undefined;
  const requestTemplate = form.requestTemplate.trim();

  return {
    name: form.name.trim(),
    type: form.type,
    models,
    enabled: form.enabled,
    ...(usesBaseUrl(form.type) && baseUrl.length > 0 ? { baseUrl } : {}),
    ...(defaultModel.length > 0 && modelIds.has(defaultModel) ? { defaultModel } : {}),
    ...(embeddingModel.length > 0 && modelIds.has(embeddingModel) ? { embeddingModel } : {}),
    ...(usesProxy(form.type) && proxy.length > 0 ? { proxy } : {}),
    ...(timeoutS !== undefined && Number.isFinite(timeoutS) ? { timeoutS } : {}),
    ...(usesRequestTemplate(form.type) && requestTemplate.length > 0 ? { requestTemplate } : {}),
  };
}
