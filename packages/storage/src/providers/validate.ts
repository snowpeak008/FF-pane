/**
 * Provider 结构校验（W1.5a）：设计文档 §4.2 四类型必填差异 + §4.1 通用约束。
 *
 * W1.1 移交说明的落地处：类型层保持扁平可选字段以贴合配置编辑界面，
 * 四类型的字段约束在此做运行时校验，create / update 时强制执行。
 *
 * 校验边界（W1.5a 决策）：
 * - 快速失败：抛出第一个违规（ProviderValidationError 带字段名）；
 *   表单级逐字段即时提示归 W3.2a 界面层。
 * - 「必须无」按 `!== undefined` 判定：空字符串不等于未设置，同样违规，
 *   由界面层负责在提交前剔除空表单项。
 * - 字面量联合字段（type / models[].kind）用 shared 的运行时守卫复核，
 *   覆盖 IPC / JSON 边界传入未收窄数据的情形；其余字段的 typeof 级别
 *   完整性由 TypeScript 类型负责，不做全量 schema 校验。
 * - requestTemplate 出现在非 custom 类型上不报错（类型层允许，运行时不使用）；
 *   校验只强制工单枚举的规则。
 */

import type { ModelId, ModelKind, Provider, ProviderModel } from "@ff-pane/shared";
import { isModelKind, isProviderType } from "@ff-pane/shared";
import { ProviderValidationError } from "./errors.js";

/** 创建 / 更新 Provider 时调用方提交的内容：除 id 外的全部字段（id 由 store 生成）。 */
export type ProviderDraft = Omit<Provider, "id">;

/** baseUrl 仅接受 http/https 形式的 URL（设计文档 §4.2：API 地址）。 */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** models 数组：条目 id 非空且唯一，kind 为合法 ModelKind。 */
function validateModels(models: readonly ProviderModel[]): void {
  if (!Array.isArray(models)) {
    throw new ProviderValidationError("models", "必须是模型条目数组");
  }
  const seenIds = new Set<string>();
  for (const model of models) {
    if (typeof model.id !== "string" || model.id.length === 0) {
      throw new ProviderValidationError("models", "模型条目必须有非空 id");
    }
    if (!isModelKind(model.kind)) {
      throw new ProviderValidationError(
        "models",
        `模型 ${model.id} 的 kind 非法：${String(model.kind)}（应为 chat 或 embedding）`,
      );
    }
    if (seenIds.has(model.id)) {
      throw new ProviderValidationError("models", `模型 id 重复：${model.id}`);
    }
    seenIds.add(model.id);
  }
}

/** defaultModel / embeddingModel 若设置，必须存在于 models 且 kind 匹配。 */
function validateModelRef(
  field: "defaultModel" | "embeddingModel",
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
  if (target.kind !== expectedKind) {
    throw new ProviderValidationError(
      field,
      `引用的模型 ${refId} 的 kind 应为 ${expectedKind}，实际为 ${target.kind}`,
    );
  }
}

/**
 * 校验 Provider 草稿（create / update 共用），违规抛带字段名的
 * ProviderValidationError。也可供上层（W1.6 / W3.2a）在提交前独立调用。
 */
export function validateProviderDraft(draft: ProviderDraft): void {
  if (!isProviderType(draft.type)) {
    throw new ProviderValidationError("type", `未知的 Provider 类型：${String(draft.type)}`);
  }
  validateModels(draft.models);

  switch (draft.type) {
    case "openai_compatible":
    case "anthropic": {
      if (draft.baseUrl === undefined) {
        throw new ProviderValidationError("baseUrl", `${draft.type} 类型必须设置 baseUrl`);
      }
      if (!isHttpUrl(draft.baseUrl)) {
        throw new ProviderValidationError(
          "baseUrl",
          `必须是 http/https 形式的 URL，实际为：${draft.baseUrl}`,
        );
      }
      if (typeof draft.apiKeyRef !== "string" || draft.apiKeyRef.length === 0) {
        throw new ProviderValidationError(
          "apiKeyRef",
          `${draft.type} 类型必须设置 apiKeyRef（密钥引用，本体在系统密钥库，§4.3）`,
        );
      }
      break;
    }
    case "cli_login": {
      if (draft.baseUrl !== undefined) {
        throw new ProviderValidationError(
          "baseUrl",
          "cli_login 类型不得设置 baseUrl（端点与凭证由 CLI 自管，§4.2）",
        );
      }
      if (draft.apiKeyRef !== undefined) {
        throw new ProviderValidationError(
          "apiKeyRef",
          "cli_login 类型不得设置 apiKeyRef（凭证由 CLI 自管，§4.2）",
        );
      }
      break;
    }
    case "custom": {
      if (typeof draft.requestTemplate !== "string" || draft.requestTemplate.length === 0) {
        throw new ProviderValidationError(
          "requestTemplate",
          "custom 类型必须提供非空 requestTemplate",
        );
      }
      if (draft.baseUrl !== undefined && !isHttpUrl(draft.baseUrl)) {
        throw new ProviderValidationError(
          "baseUrl",
          `若设置则必须是 http/https 形式的 URL，实际为：${draft.baseUrl}`,
        );
      }
      break;
    }
  }

  validateModelRef("defaultModel", draft.defaultModel, draft.models, "chat");
  validateModelRef("embeddingModel", draft.embeddingModel, draft.models, "embedding");

  if (draft.timeoutS !== undefined && (!Number.isInteger(draft.timeoutS) || draft.timeoutS <= 0)) {
    throw new ProviderValidationError("timeoutS", `必须是正整数（秒），实际为：${draft.timeoutS}`);
  }
}
