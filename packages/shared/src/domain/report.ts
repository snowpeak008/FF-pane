/**
 * Planner 跟进回路的领域类型（T9.10 第一档，开发计划 Phase 9 章 T9.10）。
 *
 * 参考 cc-pane「Worker 完工向 Planner 汇报」模式；本仓 Planner 不绑定实例，
 * 汇报对象是「当前 / 下一个 Planner 会话」——Worker 轮落定时把一句话结算摘要写入
 * **项目级待汇报队列**（落盘 planner-report.json），任一 Planner 轮开始时把
 * 「自上次 Planner 轮以来的任务看板增量（含队列）」注入提示词，消费后出队。
 *
 * 红线（第一档边界）：本类型族只描述**被动记录**——没有任何字段表达「触发一轮」。
 * Worker 落定不自动触发 Planner 轮、Planner 不自动派发，每步经用户（§13 红线）。
 */

import type { EpochMillis, RunId, TaskId } from "./common.js";
import type { TaskSettledStatus, TaskStatus } from "./task.js";

/**
 * 待汇报队列的一条结算记录：Worker 轮落定（done / failed / blocked）时生成。
 * summary 为规则拼装的一句话（第一档不用模型生成，core composeSettlementSummary）。
 */
export interface SettlementReportEntry {
  readonly taskId: TaskId;
  /** 落定状态（三态子集；accepted / cancelled 是用户亲手操作，不进队列）。 */
  readonly status: TaskSettledStatus;
  /** 一句话结算摘要（规则拼装，注入 Planner 提示词的正文）。 */
  readonly summary: string;
  /** 落定时刻（epoch 毫秒；队列按此升序）。 */
  readonly settledAt: EpochMillis;
  /** 本次落定对应的 Run（有则带上，供 Planner 溯源；修正路径等场景可缺席）。 */
  readonly runId?: RunId;
}

/**
 * 「自上次 Planner 轮以来」的增量基准点：上次 Planner 轮开始时的看板快照。
 *
 * 存快照而非只存时间戳：Task 记录不带时间戳（Task = TaskContract + status，
 * 领域事实见 shared/domain/task.ts 注释），无法按时间回答「哪些任务变了」；
 * 状态快照让增量成为一次纯函数 diff（新增 / 状态变化 / 移除），不依赖 Run 反推。
 */
export interface PlannerBoardBaseline {
  /** 基准建立时刻 = 上次 Planner 轮开始时刻。 */
  readonly plannerTurnAt: EpochMillis;
  /** 当时的看板快照：taskId → status。 */
  readonly taskStatuses: Readonly<Record<string, TaskStatus>>;
}

/** 待汇报状态的内存视图（storage readPlannerReport 的返回形状）。 */
export interface PlannerReportState {
  /** 上次 Planner 轮的看板基准（首次注入前缺席）。 */
  readonly baseline?: PlannerBoardBaseline;
  /** 待汇报队列（按 settledAt 升序）。 */
  readonly queue: readonly SettlementReportEntry[];
}
