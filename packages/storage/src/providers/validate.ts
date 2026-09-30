/**
 * Provider 结构校验（T10.3）：按模板声明的必填字段校验。
 */

import type { ModelId, ModelKind, Provider, ProviderModel } from "@ff-pane/shared";
import {
  getProviderTemplate,
  isDangerousExtraEnvName,
  isModelKind,
  isProviderTemplateId,
  providerModelKind,
} from "@ff-pane/shared";
import { ProviderValidationError } from "./errors.js";

/** 创建 / 更新 Provider 时调用方提交的内容：除 id 外；时间戳可由 store 补齐。 */
export type ProviderDraft = Omit<Provider, "id" | "createdAt" | "updatedAt"> & {
  readonly createdAt?: number;
  readonly updatedAt?: number;
};

/** baseUrl 仅接受 http/https。 */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function validateModels(models: readonly ProviderModel[]): void {
  if (!Array.isArray(models)) {
    throw new ProviderValidationError("models", "必须是模型条目数组");
  }
  const seenIds = new Set<string>();
  for (const model of models) {
    if (typeof model.id !== "string" || model.id.length === 0) {
      throw new ProviderValidationError("models", "模型条目必须有非空 id");
    }
    if (model.kind !== undefined && !isModelKind(model.kind)) {
      throw new ProviderValidationError(
        "models",
        `模型 ${model.id} 的 kind 非法：${String(model.kind)}（应为 chat 或 embedding）`,
      );
    }
    if (
      model.contextWindowTokens !== undefined &&
      (!Number.isInteger(model.contextWindowTokens) || model.contextWindowTokens <= 0)
    ) {
      throw new ProviderValidationError(
        "models",
        `模型 ${model.id} 的 contextWindowTokens 必须是正整数`,
      );
    }
    if (seenIds.has(model.id)) {
      throw new ProviderValidationError("models", `模型 id 重复：${model.id}`);
    }
    seenIds.add(model.id);
  }
}

function validateModelRef(
  field: "defaultModelId" | "embeddingModel",
  refId: ModelId | undefined,
  models: readonly ProviderModel[],
  expectedKind: ModelKind,
): void {
  if (refId === undefined) {
    return;
  }
  const target = models.find((model) => model.id === refId);
  if (target === undefined) {
    throw new ProviderValidationError(field, `引用的模型不在 models 中：${refId}`);
  }
  const kind = providerModelKind(target);
  if (kind !== expectedKind) {
    throw new ProviderValidationError(
      field,
      `引用的模型 ${refId} 的 kind 应为 ${expectedKind}，实际为 ${kind}`,
    );
  }
}

function validateExtraEnv(extraEnv: Provider["extraEnv"]): void {
  if (extraEnv === undefined) {
    return;
  }
  if (typeof extraEnv !== "object" || extraEnv === null || Array.isArray(extraEnv)) {
    throw new ProviderValidationError("extraEnv", "必须是字符串字典");
  }
  for (const [name, value] of Object.entries(extraEnv)) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new ProviderValidationError("extraEnv", "键名必须是非空字符串");
    }
    if (typeof value !== "string") {
      throw new ProviderValidationError("extraEnv", `键 ${name} 的值必须是字符串`);
    }
    if (isDangerousExtraEnvName(name)) {
      throw new ProviderValidationError(
        "extraEnv",
        `禁止设置危险变量：${name}（如 PATH / NODE_OPTIONS / LD_PRELOAD 等）`,
      );
    }
  }
}

function validateOptions(options: Provider["options"]): void {
  if (options === undefined) {
    return;
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ProviderValidationError("options", "必须是字符串字典");
  }
  for (const [name, value] of Object.entries(options)) {
    if (typeof name !== "string" || name.length === 0) {
      throw new ProviderValidationError("options", "键名必须是非空字符串");
    }
    if (typeof value !== "string") {
      throw new ProviderValidationError("options", `键 ${name} 的值必须是字符串`);
    }
  }
}

/**
 * 校验 Provider 草稿（create / update 共用）。
 */
export function validateProviderDraft(draft: ProviderDraft): void {
  if (!isProviderTemplateId(draft.templateId)) {
    throw new ProviderValidationError(
      "templateId",
      `未知的 Provider 模板：${String(draft.templateId)}`,
    );
  }
  const template = getProviderTemplate(draft.templateId);
  if (template === undefined) {
    throw new ProviderValidationError("templateId", `未知的 Provider 模板：${draft.templateId}`);
  }

  if (typeof draft.name !== "string" || draft.name.trim().length === 0) {
    throw new ProviderValidationError("name", "名称不能为空");
  }

  validateModels(draft.models);
  validateExtraEnv(draft.extraEnv);
  validateOptions(draft.options);

  const baseUrl = draft.baseUrl;
  if (template.fields.baseUrl === "required") {
    if (baseUrl === undefined || baseUrl.trim().length === 0) {
      throw new ProviderValidationError("baseUrl", `${draft.templateId} 必须设置 baseUrl`);
    }
  }
  if (template.fields.baseUrl === "hidden") {
    if (baseUrl !== undefined) {
      throw new ProviderValidationError(
        "baseUrl",
        `${draft.templateId} 不得设置 baseUrl（本机 CLI 自管端点）`,
      );
    }
  }
  if (baseUrl !== undefined && !isHttpUrl(baseUrl)) {
    throw new ProviderValidationError(
      "baseUrl",
      `必须是 http/https 形式的 URL，实际为：${baseUrl}`,
    );
  }

  if (template.fields.apiKey === "required") {
    if (typeof draft.apiKeyRef !== "string" || draft.apiKeyRef.length === 0) {
      throw new ProviderValidationError(
        "apiKeyRef",
        `${draft.templateId} 必须设置 apiKeyRef（密钥引用，本体在系统密钥库）`,
      );
    }
  }
  if (template.fields.apiKey === "hidden") {
    if (draft.apiKeyRef !== undefined) {
      throw new ProviderValidationError(
        "apiKeyRef",
        `${draft.templateId} 不得设置 apiKeyRef（凭证由 CLI 自管）`,
      );
    }
  }

  // 模板可选项取值必须在声明集合内
  if (template.options !== undefined && draft.options !== undefined) {
    for (const def of template.options) {
      const value = draft.options[def.key];
      if (value !== undefined && !def.values.includes(value)) {
        throw new ProviderValidationError(
          "options",
          `选项 ${def.key} 取值非法：${value}（应为 ${def.values.join(" / ")}）`,
        );
      }
    }
  }

  validateModelRef("defaultModelId", draft.defaultModelId, draft.models, "chat");
  validateModelRef("embeddingModel", draft.embeddingModel, draft.models, "embedding");

  if (draft.timeoutS !== undefined && (!Number.isInteger(draft.timeoutS) || draft.timeoutS <= 0)) {
    throw new ProviderValidationError("timeoutS", `必须是正整数（秒），实际为：${draft.timeoutS}`);
  }

  if (typeof draft.enabled !== "boolean") {
    throw new ProviderValidationError("enabled", "必须是布尔值");
  }
  // createdAt / updatedAt：store 在落盘前补齐；校验仅在显式传入时检查形态
  if (
    draft.createdAt !== undefined &&
    (typeof draft.createdAt !== "number" || !Number.isFinite(draft.createdAt))
  ) {
    throw new ProviderValidationError("createdAt", "必须是 epoch 毫秒");
  }
  if (
    draft.updatedAt !== undefined &&
    (typeof draft.updatedAt !== "number" || !Number.isFinite(draft.updatedAt))
  ) {
    throw new ProviderValidationError("updatedAt", "必须是 epoch 毫秒");
  }
}
