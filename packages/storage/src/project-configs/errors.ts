/**
 * configs.json 持久化错误。文件系统故障仍走 StorageFsError。
 */

import type { ProjectConfigId } from "@ff-pane/shared";

export const PROJECT_CONFIG_STORE_ERROR_CODES = [
  "config-not-found",
  "configs-file-invalid",
  "config-invalid",
  "config-last",
  "config-default-required",
] as const;

export type ProjectConfigStoreErrorCode = (typeof PROJECT_CONFIG_STORE_ERROR_CODES)[number];

export abstract class ProjectConfigStoreError extends Error {
  abstract readonly code: ProjectConfigStoreErrorCode;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ProjectConfigNotFoundError extends ProjectConfigStoreError {
  override readonly code = "config-not-found" as const;
  readonly configId: ProjectConfigId;

  constructor(configId: ProjectConfigId) {
    super(`项目配置不存在: ${configId}`);
    this.configId = configId;
  }
}

export class ProjectConfigsFileInvalidError extends ProjectConfigStoreError {
  override readonly code = "configs-file-invalid" as const;
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`configs.json 结构不符合约定（${reason}）: ${path}`);
    this.path = path;
  }
}

export class ProjectConfigDraftInvalidError extends ProjectConfigStoreError {
  override readonly code = "config-invalid" as const;
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export class ProjectConfigLastError extends ProjectConfigStoreError {
  override readonly code = "config-last" as const;

  constructor() {
    super("只剩一张配置，不能删除");
  }
}

export class ProjectConfigDefaultRequiredError extends ProjectConfigStoreError {
  override readonly code = "config-default-required" as const;

  constructor() {
    super("删除默认配置时必须同时指定另一张为默认");
  }
}

/** 收窄范围时，名单外仍有项目绑着这张配置。reason 是项目名列表。 */
export class ProjectConfigScopeBlockedError extends Error {
  readonly code = "config-scope-blocked" as const;
  readonly reason: string;

  constructor(projectNames: readonly string[]) {
    const list = projectNames.join(", ");
    super(list);
    this.name = "ProjectConfigScopeBlockedError";
    this.reason = list;
  }
}
