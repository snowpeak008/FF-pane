/**
 * Profile 持久化层错误类型（W1.6），沿用 W1.5a / W1.2a 的错误设计模式：
 * Error 子类 + `code` 字面量判别字段，既能 instanceof 捕获，又能在联合类型上
 * 用 `error.code` 穷尽分支。文件系统故障（io-error / corrupt-json / not-found）
 * 不在此重复定义——store 层直接向上传递 W1.2a 的 StorageFsError 错误族；
 * 领域校验失败由注入的校验回调抛出（错误类型归 core / 宿主，见 store.ts）。
 */

import type { ProfileId } from "@ff-pane/shared";

/** Profile 持久化层错误码（判别字段的取值全集）。 */
export const PROFILE_STORE_ERROR_CODES = ["profile-not-found", "profiles-file-invalid"] as const;

/** Profile 持久化层错误码。 */
export type ProfileStoreErrorCode = (typeof PROFILE_STORE_ERROR_CODES)[number];

/** Profile 持久化层错误基类。 */
export abstract class ProfileStoreError extends Error {
  /** 判别字段：各子类收窄为字面量类型，供联合类型穷尽分支。 */
  abstract readonly code: ProfileStoreErrorCode;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 目标 Profile 不存在（update / delete 的失败分支；get 查询不抛此错误）。 */
export class ProfileNotFoundError extends ProfileStoreError {
  override readonly code = "profile-not-found" as const;
  /** 未命中的 Profile ID。 */
  readonly profileId: ProfileId;

  constructor(profileId: ProfileId) {
    super(`Profile 不存在: ${profileId}`);
    this.profileId = profileId;
  }
}

/**
 * profiles.json 是合法 JSON 但整文件结构不符合约定（顶层非对象、版本不支持、
 * profiles 非数组）。与 JSON 语法损坏不同：语法损坏由 W1.2a 隔离并抛
 * StorageCorruptJsonError；结构不符不隔离（内容对用户仍有价值，留在原地人工修复）。
 * 语义与 W1.5a 的 ProvidersFileInvalidError 对齐。
 */
export class ProfilesFileInvalidError extends ProfileStoreError {
  override readonly code = "profiles-file-invalid" as const;
  /** 出错的 profiles.json 路径。 */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`profiles.json 结构不符合约定（${reason}）: ${path}`);
    this.path = path;
  }
}
