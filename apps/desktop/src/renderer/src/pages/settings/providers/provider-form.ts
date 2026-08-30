/**
 * Provider 编辑表单的纯逻辑（W3.2a）：类型 → 字段可见性、表单态 → 线上草稿。
 * 无 React / DOM 依赖，可直接单测（见 tests/provider-form.test.ts）。
 *
 * 校验的权威在 storage 层 validateProviderDraft（create/update 时强制执行）；
 * 本层只做"构造草稿 + 决定字段显隐"，不复制后端校验规则（避免两处漂移）。
 */

import type { ModelKind, ProviderType } from "@ff-pane/shared";
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
    timeoutS: "",
    requestTemplate: "",
    enabled: true,
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
    ...(timeoutS !== undefined && Number.isFinite(timeoutS) ? { timeoutS } : {}),
    ...(usesRequestTemplate(form.type) && requestTemplate.length > 0 ? { requestTemplate } : {}),
  };
}
