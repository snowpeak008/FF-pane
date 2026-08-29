/**
 * 计划版本演进：createNextDraft（设计文档 §6.1 / §11.3，开发计划 W1.4a）。
 * "只增不改"：修改计划从不改写现有版本，而是产生 version+1 的新 draft；
 * 旧计划对象原样不动，随后由调用方对旧计划执行 supersedePlan。
 */

import type { Plan, PlanStatus, PlanVersion, TaskContract } from "@ff-pane/shared";
import { isPlanStatus } from "@ff-pane/shared";
import { PlanTransitionError } from "./errors.js";

/**
 * 新草案相对底稿的修改内容。缺省字段沿用底稿；version / status / approvedBy
 * 不可通过此结构指定——版本递增、回到 draft、清空批准记录是本函数的固定行为。
 */
export interface PlanDraftChanges {
  readonly goal?: string;
  readonly scope?: readonly string[];
  readonly nonGoals?: readonly string[];
  readonly constraints?: readonly string[];
  readonly decisions?: readonly string[];
  readonly tasks?: readonly TaskContract[];
  readonly acceptance?: readonly string[];
}

/** 可作为新草案底稿的状态：仅活跃版本（取舍见 createNextDraft 注释）。 */
const NEXT_DRAFT_BASE_STATUSES: readonly PlanStatus[] = ["draft", "approved"];

/**
 * 以 basePlan 为底稿产生 version+1 的新 draft。旧计划不动（调用方随后 supersede）。
 *
 * 底稿状态取舍：
 * - approved 允许：§6.1 的标准场景——Planner 修改已批准计划，自动产生新版本草案。
 * - draft 允许：§11.3 的"让 Planner 修改"同样适用于未批准的草案，新草案取代旧草案。
 * - superseded 禁止：它必然已被更高版本取代，version+1 必然与现存版本撞号；
 *   正确做法是以取代它的那个（最新）版本为底稿。
 * - completed / cancelled 禁止：终态表示这条计划线已闭合（§6.1），
 *   不再有"修改产生新草案"的语义。
 *
 * 新草案中所有任务合同的 planVersion 一律重绑为新版本号：任务合同随所在计划
 * 版本走（§6.2 plan_version），沿用底稿任务时不能留下旧版本号。
 */
export function createNextDraft(basePlan: Plan, changes: PlanDraftChanges): Plan {
  if (!isPlanStatus(basePlan.status)) {
    throw new TypeError(
      `createNextDraft: 未知的 Plan 状态 ${JSON.stringify(basePlan.status)}，数据可能已损坏`,
    );
  }
  if (!NEXT_DRAFT_BASE_STATUSES.includes(basePlan.status)) {
    throw new PlanTransitionError(
      basePlan.status,
      "draft",
      `只有活跃版本（${NEXT_DRAFT_BASE_STATUSES.join("、")}）可作为新草案的底稿`,
    );
  }
  if (!Number.isSafeInteger(basePlan.version) || basePlan.version < 1) {
    throw new TypeError(
      `createNextDraft: 底稿版本号必须是从 1 开始的整数，收到 ${String(basePlan.version)}`,
    );
  }
  const nextVersion = (basePlan.version + 1) as PlanVersion;
  const tasks = (changes.tasks ?? basePlan.tasks).map((task) => ({
    ...task,
    planVersion: nextVersion,
  }));
  return {
    version: nextVersion,
    status: "draft",
    goal: changes.goal ?? basePlan.goal,
    scope: changes.scope ?? basePlan.scope,
    nonGoals: changes.nonGoals ?? basePlan.nonGoals,
    constraints: changes.constraints ?? basePlan.constraints,
    decisions: changes.decisions ?? basePlan.decisions,
    tasks,
    acceptance: changes.acceptance ?? basePlan.acceptance,
  };
}
