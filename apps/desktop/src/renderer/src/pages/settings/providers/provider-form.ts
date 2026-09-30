/**
 * Provider 编辑表单纯逻辑（T10.3）：模板驱动字段显隐 / 草稿构造。
 */

import type { ModelKind, Provider, ProviderTemplateId } from "@ff-pane/shared";
import {
  BUILTIN_PROVIDER_TEMPLATES,
  getProviderTemplate,
  providerModelKind,
  providerModelLabel,
  providerProbeKind,
  providerTemplateNeedsApiKey,
} from "@ff-pane/shared";
import type { ProviderDraftWire } from "../../../../../shared-ipc/contracts";

/** 模板卡片顺序。 */
export const PROVIDER_TEMPLATE_ORDER: readonly ProviderTemplateId[] =
  BUILTIN_PROVIDER_TEMPLATES.map((template) => template.id);

export function usesBaseUrl(templateId: ProviderTemplateId): boolean {
  const req = getProviderTemplate(templateId)?.fields.baseUrl;
  return req === "required" || req === "optional";
}

export function baseUrlRequired(templateId: ProviderTemplateId): boolean {
  return getProviderTemplate(templateId)?.fields.baseUrl === "required";
}

export function usesApiKey(templateId: ProviderTemplateId): boolean {
  return providerTemplateNeedsApiKey(templateId);
}

export function usesProxy(templateId: ProviderTemplateId): boolean {
  return usesBaseUrl(templateId);
}

export function supportsProbe(templateId: ProviderTemplateId): boolean {
  return providerProbeKind(templateId) !== "none";
}

export function usesCliEnumeratedModels(templateId: ProviderTemplateId): boolean {
  return templateId === "local-login";
}

export interface ModelRow {
  readonly id: string;
  readonly label: string;
  readonly kind: ModelKind;
}

export interface ProviderFormState {
  readonly name: string;
  readonly templateId: ProviderTemplateId;
  readonly baseUrl: string;
  readonly models: readonly ModelRow[];
  readonly defaultModelId: string;
  readonly embeddingModel: string;
  readonly proxy: string;
  readonly timeoutS: string;
  readonly enabled: boolean;
  readonly extraEnvText: string;
  readonly options: Readonly<Record<string, string>>;
  /** 编辑既有条目时保留；新建为 0（写出时改成 now）。 */
  readonly createdAt: number;
}

export function emptyProviderForm(
  templateId: ProviderTemplateId = "openai-compatible",
): ProviderFormState {
  const template = getProviderTemplate(templateId);
  const options: Record<string, string> = {};
  for (const option of template?.options ?? []) {
    options[option.key] = option.defaultValue;
  }
  return {
    name: "",
    templateId,
    baseUrl: template?.defaultBaseUrl ?? "",
    models: [],
    defaultModelId: "",
    embeddingModel: "",
    proxy: "",
    timeoutS: "",
    enabled: true,
    extraEnvText: "",
    options,
    createdAt: 0,
  };
}

export function formFromProvider(provider: Provider): ProviderFormState {
  const template = getProviderTemplate(provider.templateId);
  const options: Record<string, string> = {};
  for (const option of template?.options ?? []) {
    options[option.key] = provider.options?.[option.key] ?? option.defaultValue;
  }
  return {
    name: provider.name,
    templateId: provider.templateId,
    baseUrl: provider.baseUrl ?? template?.defaultBaseUrl ?? "",
    models: provider.models.map((model) => ({
      id: model.id,
      label:
        providerModelLabel(model) === model.id ? (model.label ?? "") : providerModelLabel(model),
      kind: providerModelKind(model),
    })),
    defaultModelId: provider.defaultModelId ?? "",
    embeddingModel: provider.embeddingModel ?? "",
    proxy: provider.proxy ?? "",
    timeoutS: provider.timeoutS !== undefined ? String(provider.timeoutS) : "",
    enabled: provider.enabled,
    extraEnvText:
      provider.extraEnv !== undefined
        ? Object.entries(provider.extraEnv)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")
        : "",
    options,
    createdAt: provider.createdAt ?? 0,
  };
}

export function cleanModels(models: readonly ModelRow[]): readonly ModelRow[] {
  return models
    .map((row) => ({ ...row, id: row.id.trim(), label: row.label.trim() }))
    .filter((row) => row.id.length > 0);
}

function parseExtraEnvText(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (key.length > 0) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildProviderDraft(form: ProviderFormState): ProviderDraftWire {
  const now = Date.now();
  const models = cleanModels(form.models).map((row) => ({
    id: row.id,
    ...(row.label.length > 0 ? { label: row.label } : {}),
    kind: row.kind,
  }));
  const modelIds = new Set(models.map((model) => model.id));
  const baseUrl = form.baseUrl.trim();
  const defaultModelId = form.defaultModelId.trim();
  const embeddingModel = form.embeddingModel.trim();
  const proxy = form.proxy.trim();
  const timeoutRaw = form.timeoutS.trim();
  const timeoutS = timeoutRaw.length > 0 ? Number(timeoutRaw) : undefined;
  const extraEnv = parseExtraEnvText(form.extraEnvText);
  const template = getProviderTemplate(form.templateId);
  const options: Record<string, string> = {};
  for (const def of template?.options ?? []) {
    const value = form.options[def.key]?.trim();
    if (value !== undefined && value.length > 0) {
      options[def.key] = value;
    }
  }

  return {
    name: form.name.trim(),
    templateId: form.templateId,
    models,
    enabled: form.enabled,
    createdAt: form.createdAt > 0 ? form.createdAt : now,
    updatedAt: now,
    ...(usesBaseUrl(form.templateId) && baseUrl.length > 0 ? { baseUrl } : {}),
    ...(defaultModelId.length > 0 && modelIds.has(defaultModelId) ? { defaultModelId } : {}),
    ...(embeddingModel.length > 0 && modelIds.has(embeddingModel) ? { embeddingModel } : {}),
    ...(usesProxy(form.templateId) && proxy.length > 0 ? { proxy } : {}),
    ...(timeoutS !== undefined && Number.isFinite(timeoutS) ? { timeoutS } : {}),
    ...(extraEnv !== undefined ? { extraEnv } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}
