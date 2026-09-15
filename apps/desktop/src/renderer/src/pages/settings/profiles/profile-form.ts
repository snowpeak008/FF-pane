/**
 * Profile 编辑表单纯逻辑（W3.2b）：表单态 ↔ 领域草稿。无 React 依赖，可单测。
 * 校验权威在 core validateProfileDraft（主进程落盘前执行），本层只构造草稿。
 */

import {
  type AgentProfile,
  type AiOutputLanguage,
  type GenericExecDelivery,
  isReasoningEffortRuntime,
  type ModelId,
  type PermissionEnvelope,
  type ProviderId,
  type Role,
  type RoleRef,
  type RuntimeId,
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
  /** T9.4b：空串 = 未设置（不传）。 */
  readonly reasoningEffort: string;
}

/**
 * 新建 Profile 的默认角色（T9.6 ⑤）：首个 Profile 默认「规划者」——会话页讨论轮
 * 只认 planner（或自定义角色）Profile，首个建成 worker 会落进「建完仍无法开聊」
 * 的暗坑（noPlannerProfile 只在 Composer 禁用提示里出现，可发现性差）。
 * 已有 Profile 后维持 worker 缺省（此时通常在补执行者，planner 多半已就位）。
 */
export function defaultRoleForNewProfile(hasAnyProfile: boolean): Role {
  return hasAnyProfile ? "worker" : "planner";
}

/** 空表单（新建默认：角色按 {@link defaultRoleForNewProfile}、注入的默认权限预设）。 */
export function emptyProfileForm(
  defaultPermission: PermissionEnvelope,
  defaultRole: Role = "worker",
): ProfileFormState {
  return {
    name: "",
    runtime: "",
    providerId: "",
    model: "",
    defaultRole,
    outputLanguage: "",
    permission: defaultPermission,
    gxCommand: "",
    // argv 缺省给一个带占位符的模板起点：core 校验要求 argv 模式必含 {task}，
    // 空模板保存必被拒，预填让"最短路径"（echo 一类）开箱即过。
    gxArgs: "{task}",
    gxDelivery: "argv",
    reasoningEffort: "",
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
    reasoningEffort: profile.reasoningEffort ?? "",
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
  const reasoningEffort = form.reasoningEffort.trim();
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
    ...(isReasoningEffortRuntime(runtime) && reasoningEffort.length > 0 ? { reasoningEffort } : {}),
  };
}
