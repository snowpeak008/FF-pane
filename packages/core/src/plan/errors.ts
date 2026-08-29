/**
 * Plan 状态机的 typed error（开发计划 W1.4a）。
 * W1.4b（Task 状态机）会并行定义自己的错误类型，两边各自放在本目录内，
 * 集成阶段由主管理员统一——接口未定稿前不做跨工单共享。
 */

import type { PlanStatus } from "@ff-pane/shared";

/**
 * 非法 Plan 状态迁移（或迁移的领域前置条件不满足，如非用户批准）时抛出。
 * 携带 from / to / 原因，供上层（UI 提示、日志）做结构化处理。
 * 注意与 TypeError 的分工：未知状态、畸形时间戳等"数据损坏"抛 TypeError；
 * 状态合法但违反 §6.1 规则的迁移才抛本错误。
 */
export class PlanTransitionError extends Error {
  override readonly name = "PlanTransitionError";
  /** 迁移前状态。 */
  readonly from: PlanStatus;
  /** 迁移目标状态。 */
  readonly to: PlanStatus;
  /** 拒绝原因（人类可读）。 */
  readonly reason: string;

  constructor(from: PlanStatus, to: PlanStatus, reason: string) {
    super(`Plan 状态迁移被拒绝（${from} → ${to}）：${reason}`);
    this.from = from;
    this.to = to;
    this.reason = reason;
  }
}
