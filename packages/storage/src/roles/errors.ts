/**
 * 自定义角色持久化层错误类型（T8.4），沿用 W1.5a / W1.6 的错误设计模式：
 * Error 子类 + `code` 字面量判别字段。文件系统故障（io-error / corrupt-json /
 * not-found）不在此重复定义——store 层直接向上传递 W1.2a 的 StorageFsError
 * 错误族；领域校验失败由注入的校验回调抛出（错误类型归 core / 宿主，见 store.ts）。
 */

import type { CustomRoleId } from "@ff-pane/shared";

/** 自定义角色持久化层错误码（判别字段的取值全集）。 */
export const ROLE_STORE_ERROR_CODES = [
  "role-not-found",
  "role-in-use",
  "roles-file-invalid",
] as const;

/** 自定义角色持久化层错误码。 */
export type RoleStoreErrorCode = (typeof ROLE_STORE_ERROR_CODES)[number];

/** 自定义角色持久化层错误基类。 */
export abstract class RoleStoreError extends Error {
  /** 判别字段：各子类收窄为字面量类型，供联合类型穷尽分支。 */
  abstract readonly code: RoleStoreErrorCode;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 目标角色不存在（update / delete 的失败分支；get 查询不抛此错误）。 */
export class RoleNotFoundError extends RoleStoreError {
  override readonly code = "role-not-found" as const;
  /** 未命中的角色 ID。 */
  readonly roleId: CustomRoleId;

  constructor(roleId: CustomRoleId) {
    super(`自定义角色不存在: ${roleId}`);
    this.roleId = roleId;
  }
}

/**
 * 删除保护：角色正被 Profile 引用（defaultRole 指向它），拒绝删除。
 * 口径与 Provider 删除保护（ProviderInUseError）一致：级联删除会静默改写
 * Profile 的语义（一个绑定了该角色的 Profile 突然换角色），拒删让用户先解绑、
 * 引用关系始终显式可见。
 */
export class RoleInUseError extends RoleStoreError {
  override readonly code = "role-in-use" as const;
  /** 被引用的角色 ID。 */
  readonly roleId: CustomRoleId;

  constructor(roleId: CustomRoleId) {
    super(`自定义角色正被 Profile 引用，拒绝删除: ${roleId}`);
    this.roleId = roleId;
  }
}

/**
 * roles.json 是合法 JSON 但整文件结构不符合约定（顶层非对象、版本不支持、
 * roles 非数组）。与 JSON 语法损坏不同：语法损坏由 W1.2a 隔离并抛
 * StorageCorruptJsonError；结构不符不隔离（内容对用户仍有价值，留在原地人工修复）。
 */
export class RolesFileInvalidError extends RoleStoreError {
  override readonly code = "roles-file-invalid" as const;
  /** 出错的 roles.json 路径。 */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`roles.json 结构不符合约定（${reason}）: ${path}`);
    this.path = path;
  }
}
