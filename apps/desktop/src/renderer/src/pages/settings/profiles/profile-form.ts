/**
 * Profile 编辑表单纯逻辑（W3.2b）：表单态 ↔ 领域草稿。无 React 依赖，可单测。
 * 校验权威在 core validateProfileDraft（主进程落盘前执行），本层只构造草稿。
 */

import type {
  AgentProfile,
  AiOutputLanguage,
  GenericExecDelivery,
  ModelId,
  PermissionEnvelope,
  ProviderId,
  RoleRef,
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
  /** 内置角色字面量或自定义角色 ID（T8.4；select 受控值，与其他字段同为 string）。 */
  readonly defaultRole: string;
  /** 空串 = 跟随全局输出语言。 */
  readonly outputLanguage: string;
  readonly permission: PermissionEnvelope;
  /** generic-exec：命令名或绝对路径（T8.4b；仅该 runtime 时进入草稿）。 */
  readonly gxCommand: string;
  /** generic-exec：参数模板，一行一个（textarea 受控值）。 */
  readonly gxArgs: string;
  /** generic-exec：任务投递方式（select 受控值，argv / stdin）。 */
  readonly gxDelivery: GenericExecDelivery;
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
    gxCommand: "",
    // argv 缺省给一个带占位符的模板起点：core 校验要求 argv 模式必含 {task}，
    // 空模板保存必被拒，预填让"最短路径"（echo 一类）开箱即过。
    gxArgs: "{task}",
    gxDelivery: "argv",
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
    gxCommand: profile.genericExec?.command ?? "",
    gxArgs: profile.genericExec?.args.join("\n") ?? "{task}",
    gxDelivery: profile.genericExec?.taskDelivery ?? "argv",
  };
}

/** 参数模板 textarea → 数组：按行拆分，去首尾空白，丢弃空行。 */
export function parseGenericExecArgs(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 表单态 → 线上草稿。exactOptionalPropertyTypes：可选字段有值才带。
 * 品牌类型在此系统边界收窄一次（providerId / model / runtime / defaultRole——
 * select 选项只来自 ROLES 与 roles:list，合法性权威在 core validateProfileDraft）。
 * genericExec 仅 runtime 为 generic-exec 时进草稿（其他 runtime 带配置会被 core 拒绝）。
 */
export function buildProfileDraft(form: ProfileFormState): ProfileDraftWire {
  const model = form.model.trim();
  const outputLanguage = form.outputLanguage.trim();
  const runtime = form.runtime.trim();
  return {
    name: form.name.trim(),
    runtime: runtime as RuntimeId,
    providerId: form.providerId as ProviderId,
    defaultRole: form.defaultRole as RoleRef,
    permissionPreset: form.permission,
    ...(model.length > 0 ? { model: model as ModelId } : {}),
    ...(outputLanguage.length > 0 ? { outputLanguage: outputLanguage as AiOutputLanguage } : {}),
    ...(runtime === "generic-exec"
      ? {
          genericExec: {
            command: form.gxCommand.trim(),
            args: parseGenericExecArgs(form.gxArgs),
            taskDelivery: form.gxDelivery,
          },
        }
      : {}),
  };
}
