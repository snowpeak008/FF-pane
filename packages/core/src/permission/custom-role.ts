/**
 * 自定义角色权限预设校验（T8.4，设计文档 §3.1 / §7）。纯逻辑、零 IO。
 *
 * 自定义角色的 permissionPreset 在信封公式里充当「角色默认」层（内置角色的
 * ROLE_DEFAULT_ENVELOPES 同位），因此它是该角色权限的上界——本校验器把住这个
 * 上界不越过用户权限上限：
 * - **§7 危险操作固定清单物理不可绕过**：dangerousOpsRequireApproval 必须为
 *   true（类型层已锁 true，本处复核 JSON / IPC 边界传入的未收窄数据）；清单
 *   本身在 run-guard 裁决层实现（judgeCommand / judgeFileChange），不读预设的
 *   任何字段即拦截，预设无从表达豁免——校验 + 裁决双层保证。
 * - **路径不出项目根**：readPaths / writePaths 逐条须为合法的项目内作用域
 *   （parsePathScope 非 null）。项目外 / `..` 攀升条目在裁决层本就不贡献权限
 *   （宁窄勿宽），此处把它升格为显式违规——用户在表单里写 `C:\` 或 `../..`
 *   应当得到一句拒绝而不是一条静默失效的规则。
 * - shell 策略须为三字面量之一（JSON 边界复核）。
 * - name / systemPrompt 非空：空提示词的角色发出去就是没有第 1 层的 Prompt，
 *   宁可建不出来也不要建出一个静默降级的角色。
 *
 * 界面层（设置页表单）只是输入通道，落盘前必经本校验器（storage RoleStore 的
 * 校验回调注入，回调抛错不落盘）——与 Profile 校验（W1.6）同款接线。
 */

import type { PermissionEnvelope } from "@ff-pane/shared";
import { isShellPolicy, SHELL_POLICIES } from "@ff-pane/shared";
import { parsePathScope } from "./paths.js";

/** 创建 / 更新自定义角色时提交的内容（id 与时间戳由 storage 层维护）。 */
export interface CustomRoleDraft {
  readonly name: string;
  readonly systemPrompt: string;
  readonly permissionPreset: PermissionEnvelope;
}

/** 单条校验违规：field 指向草稿字段（嵌套字段用点号路径），供表单定位。 */
export interface CustomRoleValidationViolation {
  readonly field: string;
  readonly reason: string;
}

/** 校验结果判别联合：ok 或全部违规的列表（一次提交看到全部问题，与 Profile 校验同款）。 */
export type CustomRoleValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly CustomRoleValidationViolation[] };

function collectScopeViolations(
  field: "permissionPreset.readPaths" | "permissionPreset.writePaths",
  scopes: readonly string[],
  violations: CustomRoleValidationViolation[],
): void {
  for (const raw of scopes) {
    if (parsePathScope(raw) === null) {
      violations.push({
        field,
        reason:
          `路径条目 ${JSON.stringify(raw)} 不属于项目内作用域` +
          "（绝对路径 / ~ / `..` 攀升均超出用户权限上限：权限信封只表达项目内范围）",
      });
    }
  }
}

/**
 * 校验自定义角色草稿（create / update 共用）。
 * 返回判别联合，收集全部违规（不快速失败）。
 */
export function validateCustomRoleDraft(draft: CustomRoleDraft): CustomRoleValidationResult {
  const violations: CustomRoleValidationViolation[] = [];

  if (draft.name.trim().length === 0) {
    violations.push({ field: "name", reason: "角色名称不能为空" });
  }
  if (draft.systemPrompt.trim().length === 0) {
    violations.push({
      field: "systemPrompt",
      reason: "角色提示词不能为空（它是该角色 Prompt 第 1 层的全部内容）",
    });
  }

  if (draft.permissionPreset.dangerousOpsRequireApproval !== true) {
    violations.push({
      field: "permissionPreset.dangerousOpsRequireApproval",
      reason: "危险操作确认不可关闭（§7 固定清单：任何角色、任何信封都不能放宽）",
    });
  }
  if (!isShellPolicy(draft.permissionPreset.shell)) {
    violations.push({
      field: "permissionPreset.shell",
      reason: `未知 shell 策略：${String(draft.permissionPreset.shell)}（应为 ${SHELL_POLICIES.join(" / ")}）`,
    });
  }
  collectScopeViolations(
    "permissionPreset.readPaths",
    draft.permissionPreset.readPaths,
    violations,
  );
  collectScopeViolations(
    "permissionPreset.writePaths",
    draft.permissionPreset.writePaths,
    violations,
  );

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** 自定义角色校验失败（携带全部违规，供宿主在 storage 校验回调中抛出）。 */
export class CustomRoleValidationError extends Error {
  override readonly name = "CustomRoleValidationError";
  /** 全部违规（与 validateCustomRoleDraft 返回的列表一致）。 */
  readonly violations: readonly CustomRoleValidationViolation[];

  constructor(violations: readonly CustomRoleValidationViolation[]) {
    const fields = violations.map((violation) => violation.field).join("、");
    super(`自定义角色校验失败（${violations.length} 处违规）：${fields}`);
    this.violations = violations;
  }
}
