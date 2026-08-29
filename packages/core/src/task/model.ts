/**
 * task 状态机的本地词汇与扩展标记（W1.4b）。
 * Task/Run 本体定义在 @ff-pane/shared（W1.1 定稿，不改接口）；
 * 本模块以结构化扩展（附加字段的子类型）承载状态机需要的溯源标记。
 */

import type { EpochMillis, Run, RunEndReason, Task } from "@ff-pane/shared";
import { createLiteralGuard } from "@ff-pane/shared";

/**
 * 任务操作的动作方。acceptTask 仅接受 "user"——done ≠ accepted 的执行抓手（§6.3）；
 * Reviewer 的结论只供用户参考，不构成验收。
 */
export const TASK_ACTORS = ["user", "planner", "worker", "reviewer", "system"] as const;

/** 任务操作动作方。 */
export type TaskActor = (typeof TASK_ACTORS)[number];

/** TaskActor 运行时守卫。 */
export const isTaskActor = createLiteralGuard(TASK_ACTORS);

/** 设计文档 §6.3 / §6.5 / §7 —— blocked 的两种成因：澄清请求、权限扩展请求。 */
export const TASK_BLOCK_REASONS = ["clarification", "permission"] as const;

/** 任务阻塞原因。 */
export type TaskBlockReason = (typeof TASK_BLOCK_REASONS)[number];

/** TaskBlockReason 运行时守卫。 */
export const isTaskBlockReason = createLiteralGuard(TASK_BLOCK_REASONS);

/**
 * done 的取得方式（W1.4b 定义的 done 判定规则，权威定义见 completeTask）：
 * - "verify-cmd-passed"：任务合同带 verify_cmd（§6.2），Run 的 VerifyResult
 *   命令与合同一致且退出码 0（§6.4）；
 * - "report-unverified"：任务合同无 verify_cmd（如纯文档任务），凭 Worker 完成报告
 *   + completed Run 记录取得。这是"未经命令验证"的显式标记，
 *   供 UI 与 Reviewer 识别（§11.4 / §11.5）。
 */
export const DONE_EVIDENCE_KINDS = ["verify-cmd-passed", "report-unverified"] as const;

/** done 证据类型。 */
export type DoneEvidenceKind = (typeof DONE_EVIDENCE_KINDS)[number];

/** DoneEvidenceKind 运行时守卫。 */
export const isDoneEvidenceKind = createLiteralGuard(DONE_EVIDENCE_KINDS);

/** blocked 任务：附带阻塞原因标记，供任务页置顶展示待答请求（§11.4）。 */
export interface BlockedTask extends Task {
  readonly status: "blocked";
  /** 阻塞原因；resumeTask 恢复时移除（答复已消化，不留陈旧标记）。 */
  readonly blockReason: TaskBlockReason;
}

/** done 任务：附带证据标记；acceptTask 保留该标记，验收后仍可审计完成方式。 */
export interface DoneTask extends Task {
  readonly status: "done";
  /** done 的取得方式。"report-unverified" 即"未经命令验证"的显式标记。 */
  readonly doneEvidence: DoneEvidenceKind;
}

/** 已结束的 Run：endedAt 与 endReason 成对在场（§6.4，成对性由 endRun 保证）。 */
export interface EndedRun extends Run {
  readonly endedAt: EpochMillis;
  readonly endReason: RunEndReason;
}

/** Run 是否已结束：两个结束字段必须同时在场，半写状态视为损坏记录、不算结束。 */
export function isRunEnded(run: Run): run is EndedRun {
  return run.endedAt !== undefined && run.endReason !== undefined;
}

/** Run 是否在飞：两个结束字段必须同时缺席，半写状态同样不算在飞。 */
export function isRunInFlight(run: Run): boolean {
  return run.endedAt === undefined && run.endReason === undefined;
}
