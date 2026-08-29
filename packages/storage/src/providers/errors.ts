/**
 * Provider 配置层错误类型（W1.5a），沿用 W1.2a 的错误设计模式：
 * Error 子类 + `code` 字面量判别字段，既能 instanceof 捕获，又能在联合类型上
 * 用 `error.code` 穷尽分支。文件系统故障（io-error / corrupt-json / not-found）
 * 不在此重复定义——store 层直接向上传递 W1.2a 的 StorageFsError 错误族。
 */

import type { ProviderId } from "@ff-pane/shared";

/** Provider 配置层错误码（判别字段的取值全集）。 */
export const PROVIDER_STORE_ERROR_CODES = [
  "provider-validation",
  "provider-not-found",
  "provider-in-use",
  "providers-file-invalid",
] as const;

/** Provider 配置层错误码。 */
export type ProviderStoreErrorCode = (typeof PROVIDER_STORE_ERROR_CODES)[number];

/** Provider 配置层错误基类。 */
export abstract class ProviderStoreError extends Error {
  /** 判别字段：各子类收窄为字面量类型，供联合类型穷尽分支。 */
  abstract readonly code: ProviderStoreErrorCode;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * 结构校验失败（设计文档 §4.1 / §4.2 的字段约束）。
 * `field` 指向违规的 Provider 领域字段名（如 "baseUrl"、"defaultModel"），
 * 供设置页（W3.2a）定位到具体表单项。快速失败：只报告第一个违规。
 */
export class ProviderValidationError extends ProviderStoreError {
  override readonly code = "provider-validation" as const;
  /** 违规字段名（Provider 领域字段，camelCase）。 */
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Provider 校验失败（字段 ${field}）：${reason}`);
    this.field = field;
  }
}

/** 目标 Provider 不存在（update / delete 的失败分支；get 查询不抛此错误）。 */
export class ProviderNotFoundError extends ProviderStoreError {
  override readonly code = "provider-not-found" as const;
  /** 未命中的 Provider ID。 */
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    super(`Provider 不存在: ${providerId}`);
    this.providerId = providerId;
  }
}

/** 删除保护：Provider 正被引用（如 Profile，检查逻辑归 W1.6），拒绝删除。 */
export class ProviderInUseError extends ProviderStoreError {
  override readonly code = "provider-in-use" as const;
  /** 被引用的 Provider ID。 */
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    super(`Provider 正被引用，拒绝删除: ${providerId}`);
    this.providerId = providerId;
  }
}

/**
 * providers.json 是合法 JSON 但整文件结构不符合约定（顶层非对象、版本不支持、
 * providers 非数组）。与 JSON 语法损坏不同：语法损坏由 W1.2a 隔离并抛
 * StorageCorruptJsonError；结构不符不隔离（内容对用户仍有价值，留在原地人工修复）。
 */
export class ProvidersFileInvalidError extends ProviderStoreError {
  override readonly code = "providers-file-invalid" as const;
  /** 出错的 providers.json 路径。 */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`providers.json 结构不符合约定（${reason}）: ${path}`);
    this.path = path;
  }
}
