/**
 * Agent Profile 校验（W1.6，设计文档 §4.4 / §3.1）。纯逻辑、零 IO。
 *
 * 校验边界（W1.6 决策）：
 * - Provider 查询以依赖注入进来（ProfileValidationDeps.getProvider），本模块
 *   不 import storage——core / storage 互不依赖，宿主接线时把 W1.5a 的
 *   ProviderStore.getProvider 递进来即可（其约定：不存在返回 undefined，不抛错）。
 * - 结果是判别联合（ok / 违规列表）而非快速失败抛错：Profile 表单（W3.2b）
 *   需要一次提交看到全部违规，逐条定位到字段。
 * - 权限预设合规（W1.1 移交的"非法组合"规则，开发计划 T1.6）：预设不得宽于
 *   默认角色信封，用 W1.4c 的 intersectEnvelopes 验证"预设 ∩ 角色默认 = 预设"
 *   （即预设 ⊆ 角色默认）。典型违规：Planner 预设含写路径。
 * - runtime（开放集合，注册表归 W2.1c）与 name（用户自由起名，与 W1.5a 的
 *   Provider name 同规）不在校验范围。
 * - 字面量联合字段（defaultRole / outputLanguage / permissionPreset.shell）用
 *   shared 的运行时守卫复核，覆盖 IPC / JSON 边界传入未收窄数据的情形；
 *   其余字段的 typeof 级完整性由 TypeScript 类型负责（与 W1.5a 同边界）。
 */

import type { AgentProfile, PermissionEnvelope, Provider, ProviderId, Role } from "@ff-pane/shared";
import {
  AI_OUTPUT_LANGUAGES,
  isAiOutputLanguage,
  isRole,
  isShellPolicy,
  ROLES,
} from "@ff-pane/shared";
import { intersectEnvelopes, ROLE_DEFAULT_ENVELOPES } from "../permission/index.js";

/** 创建 / 更新 Profile 时调用方提交的内容：除 id 外的全部字段（id 由 storage 生成）。 */
export type ProfileDraft = Omit<AgentProfile, "id">;

/**
 * 校验依赖：Provider 查询的注入点。
 * 兼容同步与异步实现——W1.5a ProviderStore.getProvider 是异步（读 providers.json），
 * 测试与内存实现可用同步函数。
 */
export interface ProfileValidationDeps {
  /** 按 id 查询 Provider。不存在返回 undefined（与 W1.5a 约定一致，不抛错）。 */
  readonly getProvider: (id: ProviderId) => Provider | undefined | Promise<Provider | undefined>;
}

/** 单条校验违规：field 指向 Profile 领域字段（camelCase，嵌套字段用点号路径）。 */
export interface ProfileValidationViolation {
  /** 违规字段名（如 "providerId"、"permissionPreset.writePaths"），供表单定位。 */
  readonly field: string;
  /** 拒绝原因（人类可读）。 */
  readonly reason: string;
}

/** 校验结果判别联合：ok 或全部违规的列表（一次提交看到全部问题）。 */
export type ProfileValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly ProfileValidationViolation[] };

/** 作用域列表按集合比较（元素为 intersectScopeLists 的规范字符串形态，顺序无关）。 */
function sameScopeSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((scope, index) => scope === sortedB[index]);
}

/**
 * 权限预设合规检查："预设 ∩ 角色默认 = 预设" ⇔ 预设 ⊆ 角色默认。
 * 实现：intersectEnvelopes(预设, 预设) 得到预设的规范形态（作用域列表去重、
 * 剔除被同伴覆盖与无效条目后的渲染），再与 intersectEnvelopes(预设, 角色默认)
 * 逐维比较——任何一维在交集后变窄，即证明预设在该维宽于角色默认。
 */
function collectPresetViolations(
  preset: PermissionEnvelope,
  role: Role,
): ProfileValidationViolation[] {
  const roleDefault = ROLE_DEFAULT_ENVELOPES[role];
  const canonical = intersectEnvelopes(preset, preset);
  const clamped = intersectEnvelopes(preset, roleDefault);
  const violations: ProfileValidationViolation[] = [];
  if (!sameScopeSet(canonical.readPaths, clamped.readPaths)) {
    violations.push({
      field: "permissionPreset.readPaths",
      reason:
        `可读范围宽于默认角色 ${role} 的信封：预设 [${canonical.readPaths.join(", ")}] ` +
        `与角色默认交集后收窄为 [${clamped.readPaths.join(", ")}]`,
    });
  }
  if (!sameScopeSet(canonical.writePaths, clamped.writePaths)) {
    violations.push({
      field: "permissionPreset.writePaths",
      reason:
        `可写范围宽于默认角色 ${role} 的信封：预设 [${canonical.writePaths.join(", ")}] ` +
        `与角色默认交集后收窄为 [${clamped.writePaths.join(", ")}]`,
    });
  }
  if (clamped.shell !== preset.shell) {
    violations.push({
      field: "permissionPreset.shell",
      reason: `shell 策略 ${preset.shell} 宽于默认角色 ${role} 的 ${roleDefault.shell}`,
    });
  }
  if (clamped.network !== preset.network) {
    violations.push({
      field: "permissionPreset.network",
      reason: `网络权限宽于默认角色 ${role} 的信封（角色默认禁止，预设开启）`,
    });
  }
  return violations;
}

/**
 * 校验 Profile 草稿（create / update 共用）。
 * 返回判别联合，收集全部违规（不快速失败）；依赖检查跳过规则：
 * Provider 不存在时不再查模型；defaultRole 非法时无从取角色默认信封，
 * 预设合规检查随之跳过（角色本身已在违规列表中）。
 */
export async function validateProfileDraft(
  draft: ProfileDraft,
  deps: ProfileValidationDeps,
): Promise<ProfileValidationResult> {
  const violations: ProfileValidationViolation[] = [];

  const provider = await deps.getProvider(draft.providerId);
  if (provider === undefined) {
    violations.push({ field: "providerId", reason: `Provider 不存在：${draft.providerId}` });
  } else if (draft.model === undefined) {
    // §4.4：Model 缺省 = 用 Provider 的 defaultModel，此时该默认必须已配置
    if (provider.defaultModel === undefined) {
      violations.push({
        field: "model",
        reason: `model 缺省表示使用 Provider 默认模型，但 Provider「${provider.name}」未配置 defaultModel`,
      });
    }
  } else {
    const target = provider.models.find((model) => model.id === draft.model);
    if (target === undefined) {
      violations.push({
        field: "model",
        reason: `模型不在 Provider「${provider.name}」的 models 中：${draft.model}`,
      });
    } else if (target.kind !== "chat") {
      violations.push({
        field: "model",
        reason: `模型 ${draft.model} 的 kind 应为 chat，实际为 ${target.kind}`,
      });
    }
  }

  if (!isRole(draft.defaultRole)) {
    violations.push({
      field: "defaultRole",
      reason: `未知角色：${String(draft.defaultRole)}（应为 ${ROLES.join(" / ")}）`,
    });
  }

  if (draft.outputLanguage !== undefined && !isAiOutputLanguage(draft.outputLanguage)) {
    violations.push({
      field: "outputLanguage",
      reason:
        `未知输出语言：${String(draft.outputLanguage)}` +
        `（应为 ${AI_OUTPUT_LANGUAGES.join(" / ")}，缺省 = 跟随全局）`,
    });
  }

  if (draft.permissionPreset.dangerousOpsRequireApproval !== true) {
    violations.push({
      field: "permissionPreset.dangerousOpsRequireApproval",
      reason: "危险操作确认不可关闭（§7 第 5 项恒为 true，任何信封不能放宽）",
    });
  }
  if (!isShellPolicy(draft.permissionPreset.shell)) {
    violations.push({
      field: "permissionPreset.shell",
      reason: `未知 shell 策略：${String(draft.permissionPreset.shell)}`,
    });
  } else if (isRole(draft.defaultRole)) {
    violations.push(...collectPresetViolations(draft.permissionPreset, draft.defaultRole));
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
