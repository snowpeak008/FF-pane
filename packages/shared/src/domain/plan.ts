/**
 * 计划：版本化的工作合同（设计文档 §6.1）。
 * 版本递增与状态流转逻辑属 W1.4a，本文件只定稿结构与状态集合。
 */

import type { EpochMillis, PlanVersion } from "./common.js";
import { createLiteralGuard } from "./common.js";
import type { TaskContract } from "./task.js";

/** 设计文档 §6.1 —— 计划状态（5 种）。 */
export const PLAN_STATUSES = ["draft", "approved", "superseded", "completed", "cancelled"] as const;

/**
 * 设计文档 §6.1 —— 计划状态。
 * 规则：只有 approved 的计划可派发任务；Planner 修改已批准计划自动产生新版本
 * 草案，旧版本转 superseded。
 */
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** PlanStatus 运行时守卫。 */
export const isPlanStatus = createLiteralGuard(PLAN_STATUSES);

/**
 * 设计文档 §6.1 —— approved_by 批准记录（用户 + 时间）。
 * 批准动作只能由用户在界面上完成，任何 Agent 不能标记计划为已批准，
 * 故 by 的类型固定为 "user"。
 */
export interface PlanApproval {
  /** 设计文档 §6.1 —— 批准人：只能是用户。 */
  readonly by: "user";
  /** 设计文档 §6.1 —— 批准时间（epoch 毫秒）。 */
  readonly at: EpochMillis;
}

/**
 * 设计文档 §6.1 —— Plan：版本化的工作合同。
 * 计划在项目内以版本号为键（plan-v1、plan-v2…），只增不改，无独立 ID。
 * scope/nonGoals/constraints/decisions/acceptance 采用条目数组：
 * 计划是"可核对的合同"，逐条列出优于整段文本（正文渲染属展示层）。
 */
export interface Plan {
  /** 设计文档 §6.1 —— version：v1, v2, v3…（只增不改，修改即产生新版本）。 */
  readonly version: PlanVersion;
  /** 设计文档 §6.1 —— status。 */
  readonly status: PlanStatus;
  /** 设计文档 §6.1 —— goal 目标（一段话）。 */
  readonly goal: string;
  /** 设计文档 §6.1 —— scope 范围（做什么）。 */
  readonly scope: readonly string[];
  /** 设计文档 §6.1 —— non_goals 非目标（明确不做什么）。 */
  readonly nonGoals: readonly string[];
  /** 设计文档 §6.1 —— constraints 约束与禁止事项。 */
  readonly constraints: readonly string[];
  /** 设计文档 §6.1 —— decisions 本计划包含的已确认决定。 */
  readonly decisions: readonly string[];
  /**
   * 设计文档 §6.1 —— tasks 任务列表（含依赖关系，见 TaskContract.dependsOn）。
   * 计划内是纯合同；带状态的 Task 记录在计划批准后生成（§12 步骤 5）。
   */
  readonly tasks: readonly TaskContract[];
  /** 设计文档 §6.1 —— acceptance 总体验收标准。 */
  readonly acceptance: readonly string[];
  /** 设计文档 §6.1 —— approved_by 批准记录（draft 阶段缺省）。 */
  readonly approvedBy?: PlanApproval;
}
