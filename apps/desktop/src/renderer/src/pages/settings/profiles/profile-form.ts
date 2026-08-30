/**
 * Profile 编辑表单纯逻辑（W3.2b）：表单态 ↔ 领域草稿。无 React 依赖，可单测。
 * 校验权威在 core validateProfileDraft（主进程落盘前执行），本层只构造草稿。
 */

import type {
  AgentProfile,
  AiOutputLanguage,
  ModelId,
  PermissionEnvelope,
  ProviderId,
  Role,
  RuntimeId,
} from "@ff-pane/shared";
import type { ProfileDraftWire } from "../../../../../shared-ipc/contracts";

/** 编辑表单状态（全字符串 + 权限对象，贴合受控输入）。 */
export interface ProfileFormState {
  readonly name: string;
  readonly runtime: string;
  readonly providerId: string;
  /** 空串 = 用 Provider 默认模型。 */
  readonly model: string;
  readonly defaultRole: Role;
  /** 空串 = 跟随全局输出语言。 */
  readonly outputLanguage: string;
  readonly permission: PermissionEnvelope;
}

/** 空表单（新建默认：worker 角色、注入的默认权限预设）。 */
export function emptyProfileForm(defaultPermission: PermissionEnvelope): ProfileFormState {
  return {
    name: "",
    runtime: "",
    providerId: "",
    model: "",
    defaultRole: "worker",
    outputLanguage: "",
    permission: defaultPermission,
  };
}

/** 既有 Profile → 表单态。 */
export function formFromProfile(profile: AgentProfile): ProfileFormState {
  return {
    name: profile.name,
    runtime: profile.runtime,
    providerId: profile.providerId,
    model: profile.model ?? "",
    defaultRole: profile.defaultRole,
    outputLanguage: profile.outputLanguage ?? "",
    permission: profile.permissionPreset,
  };
}

/**
 * 表单态 → 线上草稿。exactOptionalPropertyTypes：可选字段有值才带。
 * 品牌类型在此系统边界收窄一次（providerId / model / runtime）。
 */
export function buildProfileDraft(form: ProfileFormState): ProfileDraftWire {
  const model = form.model.trim();
  const outputLanguage = form.outputLanguage.trim();
  return {
    name: form.name.trim(),
    runtime: form.runtime.trim() as RuntimeId,
    providerId: form.providerId as ProviderId,
    defaultRole: form.defaultRole,
    permissionPreset: form.permission,
    ...(model.length > 0 ? { model: model as ModelId } : {}),
    ...(outputLanguage.length > 0 ? { outputLanguage: outputLanguage as AiOutputLanguage } : {}),
  };
}
