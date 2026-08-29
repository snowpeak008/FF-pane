/**
 * Profile 校验的 typed error（W1.6）。
 * validateProfileDraft 本身返回判别联合（表单场景要一次拿到全部违规），
 * 本错误类是"抛错通道"的封装：storage 的 ProfileStore（W1.6 storage 侧）
 * 通过注入的校验回调拒绝落盘，回调以抛错表达拒绝——宿主接线时把校验结果
 * 包成本错误抛出，violations 结构化信息随错误上行到 IPC / 界面层。
 */

import type { ProfileValidationViolation } from "./validate.js";

/** Profile 校验失败（携带全部违规，供宿主在校验回调中抛出）。 */
export class ProfileValidationError extends Error {
  override readonly name = "ProfileValidationError";
  /** 全部违规（与 validateProfileDraft 返回的列表一致）。 */
  readonly violations: readonly ProfileValidationViolation[];

  constructor(violations: readonly ProfileValidationViolation[]) {
    const fields = violations.map((violation) => violation.field).join("、");
    super(`Profile 校验失败（${violations.length} 处违规）：${fields}`);
    this.violations = violations;
  }
}
