/**
 * Plan 状态机：合法迁移表与迁移函数（设计文档 §6.1 / §11.3，开发计划 W1.4a）。
 * 纯逻辑、零 IO；所有函数不修改入参，更新一律返回新对象（spread）。
 */

import type { Plan, PlanApproval, PlanStatus } from "@ff-pane/shared";
import { isPlanStatus } from "@ff-pane/shared";
import { PlanTransitionError } from "./errors.js";

/**
 * 合法迁移表（数据形式的唯一事实来源；canTransitionPlan 与四个迁移函数均查此表）。
 *
 * 边界取舍：
 * - draft → superseded 允许：§11.3 的"让 Planner 修改（产生新草案版本）"并不
 *   区分当前版本是 draft 还是 approved。新草案（vN+1）取代旧草案（vN）时，
 *   旧草案若停留在 draft，版本列表会同时存在多个"活跃草案"；标 cancelled 又会
 *   与"用户主动放弃整条思路"混淆。统一用 superseded 表达"被更高版本取代"，
 *   与 §6.1 的 approved → superseded 语义一致。
 * - draft → completed 禁止：§6.1 规定只有 approved 的计划可以派发任务，
 *   未经批准的计划不存在"执行完成"——完成必须先过用户批准这道闸门。
 * - 任何状态 → draft 均禁止：版本只增不改（§6.1），不存在"原地打回草稿"；
 *   进入 draft 的唯一途径是 createNextDraft 产生 version+1 的新计划对象。
 * - superseded / completed / cancelled 为终态，无任何出边：历史版本永不复活，
 *   要继续演进只能以当前活跃版本为底稿产生新草案。
 */
export const PLAN_LEGAL_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ["approved", "superseded", "cancelled"],
  approved: ["superseded", "completed", "cancelled"],
  superseded: [],
  completed: [],
  cancelled: [],
};

/**
 * 查表判断迁移是否合法。未知状态一律返回 false 而不抛错——
 * 适合 UI 层做按钮可用性判断（§11.3 计划页操作）。
 */
export function canTransitionPlan(from: PlanStatus, to: PlanStatus): boolean {
  if (!isPlanStatus(from) || !isPlanStatus(to)) {
    return false;
  }
  return PLAN_LEGAL_TRANSITIONS[from].includes(to);
}

/** 入参校验：状态必须是已知的 PlanStatus，否则视为数据损坏（TypeError，而非状态机错误）。 */
function assertKnownStatus(status: PlanStatus, context: string): void {
  if (!isPlanStatus(status)) {
    throw new TypeError(`${context}: 未知的 Plan 状态 ${JSON.stringify(status)}，数据可能已损坏`);
  }
}

/** 校验 from → to 的合法性，非法迁移抛 PlanTransitionError（携带 from/to/原因）。 */
function assertLegalTransition(from: PlanStatus, to: PlanStatus, context: string): void {
  assertKnownStatus(from, context);
  if (!canTransitionPlan(from, to)) {
    const targets = PLAN_LEGAL_TRANSITIONS[from];
    const reason =
      targets.length === 0
        ? `${from} 是终态，不允许任何迁移`
        : `${from} 的合法迁移目标仅限 ${targets.join("、")}`;
    throw new PlanTransitionError(from, to, reason);
  }
}

/**
 * 批准计划：draft → approved，写入批准记录与时间（设计文档 §6.1）。
 * 批准动作只能由用户完成——approval.by 虽在类型层固定为 "user"，仍做运行时
 * 强制校验（数据可能来自 JSON 边界），任何 Agent 伪造的批准都会被拒绝。
 */
export function approvePlan(plan: Plan, approval: PlanApproval): Plan {
  assertLegalTransition(plan.status, "approved", "approvePlan");
  if (approval.by !== "user") {
    throw new PlanTransitionError(
      plan.status,
      "approved",
      "批准动作只能由用户在界面上完成，任何 Agent 不能标记计划为已批准（§6.1）",
    );
  }
  if (!Number.isSafeInteger(approval.at) || approval.at <= 0) {
    throw new TypeError(
      `approvePlan: 批准时间必须是正整数 epoch 毫秒，收到 ${String(approval.at)}`,
    );
  }
  return { ...plan, status: "approved", approvedBy: { by: "user", at: approval.at } };
}

/** 计划被更高版本取代：draft | approved → superseded（设计文档 §6.1）。 */
export function supersedePlan(plan: Plan): Plan {
  assertLegalTransition(plan.status, "superseded", "supersedePlan");
  return { ...plan, status: "superseded" };
}

/** 计划执行完成：approved → completed。未批准的计划不可完成（见迁移表注释）。 */
export function completePlan(plan: Plan): Plan {
  assertLegalTransition(plan.status, "completed", "completePlan");
  return { ...plan, status: "completed" };
}

/** 取消计划：draft | approved → cancelled（用户主动放弃这条计划线）。 */
export function cancelPlan(plan: Plan): Plan {
  assertLegalTransition(plan.status, "cancelled", "cancelPlan");
  return { ...plan, status: "cancelled" };
}
