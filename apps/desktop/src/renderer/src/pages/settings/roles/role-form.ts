/**
 * 自定义角色编辑表单纯逻辑（T8.4）：表单态 ↔ 线上草稿。无 React 依赖，可单测。
 * 校验权威在 core validateCustomRoleDraft（主进程落盘前执行），本层只构造草稿。
 */

import type { CustomRole, PermissionEnvelope } from "@ff-pane/shared";
import type { CustomRoleDraftWire } from "../../../../../shared-ipc/contracts";

/** 编辑表单状态（字符串 + 权限对象，贴合受控输入）。 */
export interface RoleFormState {
  readonly name: string;
  readonly systemPrompt: string;
  readonly permission: PermissionEnvelope;
}

/** 空表单（新建默认：注入的默认权限预设）。 */
export function emptyRoleForm(defaultPermission: PermissionEnvelope): RoleFormState {
  return {
    name: "",
    systemPrompt: "",
    permission: defaultPermission,
  };
}

/** 既有角色 → 表单态。 */
export function formFromRole(role: CustomRole): RoleFormState {
  return {
    name: role.name,
    systemPrompt: role.systemPrompt,
    permission: role.permissionPreset,
  };
}

/** 表单态 → 线上草稿（name / systemPrompt 去首尾空白；非空校验在 core）。 */
export function buildRoleDraft(form: RoleFormState): CustomRoleDraftWire {
  return {
    name: form.name.trim(),
    systemPrompt: form.systemPrompt.trim(),
    permissionPreset: form.permission,
  };
}
