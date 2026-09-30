/**
 * 工作台角色说明书路径（T10.6）。
 * 开发态：应用目录 resources/workbench-roles。
 * 打包后：extraResources → process.resourcesPath/workbench-roles。
 */

import { join } from "node:path";

export interface ResolveWorkbenchRoleResourcesInput {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
}

/** 打包后走 resourcesPath；开发与 `electron .` 走 appPath/resources。 */
export function resolveWorkbenchRoleResourcesDir(
  input: ResolveWorkbenchRoleResourcesInput,
): string {
  if (input.isPackaged) {
    return join(input.resourcesPath, "workbench-roles");
  }
  return join(input.appPath, "resources", "workbench-roles");
}

/** 覆盖副本目录（应用数据根下，测试用 FF_PANE_DATA_ROOT 隔离）。 */
export function resolveWorkbenchRoleOverridesDir(dataRoot: string): string {
  return join(dataRoot, "workbench-role-overrides");
}
