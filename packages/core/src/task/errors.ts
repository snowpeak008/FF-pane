/**
 * task 状态机的类型化错误（W1.4b）。
 * 并行工单约束：错误类型先定义在本目录，集成阶段由主管理员统一归口。
 * 每类错误带字面量 code 与结构化字段，调用方既可 instanceof 也可按 code 分派。
 */

import type { RunId, TaskId, TaskStatus } from "@ff-pane/shared";
import type { TaskActor } from "./model.js";

/** 八个迁移函数的名字（错误定位用）。 */
export const TASK_TRANSITION_ACTIONS = [
  "dispatchTask",
  "blockTask",
  "resumeTask",
  "failTask",
  "completeTask",
  "acceptTask",
  "cancelTask",
  "reworkTask",
] as const;

/** 迁移动作名。 */
export type TaskTransitionAction = (typeof TASK_TRANSITION_ACTIONS)[number];

/** 非法状态迁移被拒绝（迁移表见 transitions.ts）。 */
export class InvalidTaskTransitionError extends Error {
  readonly code = "task-transition-invalid" as const;
  readonly taskId: TaskId;
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  /** 发起迁移的函数名，便于定位调用点。 */
  readonly action: TaskTransitionAction;

  constructor(params: {
    taskId: TaskId;
    from: TaskStatus;
    to: TaskStatus;
    action: TaskTransitionAction;
  }) {
    super(`${params.action}: 任务 ${params.taskId} 不允许从 ${params.from} 迁移到 ${params.to}`);
    this.name = "InvalidTaskTransitionError";
    this.taskId = params.taskId;
    this.from = params.from;
    this.to = params.to;
    this.action = params.action;
  }
}

/** 动作方无权执行该任务操作（当前仅 acceptTask 限定为用户，§6.3）。 */
export class UnauthorizedTaskActorError extends Error {
  readonly code = "task-actor-unauthorized" as const;
  readonly taskId: TaskId;
  readonly action: TaskTransitionAction;
  readonly actor: TaskActor;

  constructor(params: { taskId: TaskId; action: TaskTransitionAction; actor: TaskActor }) {
    super(`${params.action}: 动作方 ${params.actor} 无权执行（任务 ${params.taskId}，仅限用户）`);
    this.name = "UnauthorizedTaskActorError";
    this.taskId = params.taskId;
    this.action = params.action;
    this.actor = params.actor;
  }
}

/**
 * done 证据被拒的具体原因（completeTask 的判定规则见 task-machine.ts）：
 * - "run-task-mismatch"：证据 Run 不属于该任务；
 * - "run-not-completed"：Run 未结束，或 endReason 不是 completed；
 * - "verify-result-missing"：合同带 verifyCmd 但 Run 没有 VerifyResult；
 * - "verify-command-mismatch"：VerifyResult 的命令与合同 verifyCmd 不一致；
 * - "verify-cmd-failed"：验证命令退出码非 0（§6.4：通过与否 = exitCode === 0）；
 * - "report-missing"：合同无 verifyCmd 且 Run 没有非空白的 Worker 报告。
 */
export const DONE_EVIDENCE_REJECTIONS = [
  "run-task-mismatch",
  "run-not-completed",
  "verify-result-missing",
  "verify-command-mismatch",
  "verify-cmd-failed",
  "report-missing",
] as const;

/** done 证据拒绝原因。 */
export type DoneEvidenceRejection = (typeof DONE_EVIDENCE_REJECTIONS)[number];

/** 无证据（或证据不合格）的 done 被拒绝——不存在无证据的 done。 */
export class DoneEvidenceError extends Error {
  readonly code = "task-done-evidence-rejected" as const;
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly reason: DoneEvidenceRejection;

  constructor(params: { taskId: TaskId; runId: RunId; reason: DoneEvidenceRejection }) {
    super(
      `completeTask: 任务 ${params.taskId} 的 done 证据被拒（${params.reason}，Run ${params.runId}）`,
    );
    this.name = "DoneEvidenceError";
    this.taskId = params.taskId;
    this.runId = params.runId;
    this.reason = params.reason;
  }
}

/**
 * Run 生命周期违规的具体原因：
 * - "task-not-running"：startRun 要求任务已处于 running（先走派发/返工迁移）；
 * - "concurrent-run"：同一任务已有在飞 Run（含半写损坏记录，宁可拒绝也不并发）；
 * - "run-not-in-flight"：endRun 的对象已结束或为半写损坏记录；
 * - "run-not-ended"：settleTaskAfterRun 要求 Run 已结束（endedAt/endReason 成对在场）；
 * - "run-task-mismatch"：Run 不属于该任务。
 */
export const RUN_LIFECYCLE_VIOLATIONS = [
  "task-not-running",
  "concurrent-run",
  "run-not-in-flight",
  "run-not-ended",
  "run-task-mismatch",
] as const;

/** Run 生命周期违规原因。 */
export type RunLifecycleViolation = (typeof RUN_LIFECYCLE_VIOLATIONS)[number];

/** Run 生命周期约束被违反。 */
export class RunLifecycleError extends Error {
  readonly code = "run-lifecycle-violation" as const;
  readonly reason: RunLifecycleViolation;
  readonly taskId: TaskId;
  /** 涉事 Run（如冲突的在飞 Run）；startRun 前置检查失败时无 Run 可指。 */
  readonly runId: RunId | undefined;

  constructor(params: { reason: RunLifecycleViolation; taskId: TaskId; runId?: RunId }) {
    super(`Run 生命周期违规（${params.reason}，任务 ${params.taskId}）`);
    this.name = "RunLifecycleError";
    this.reason = params.reason;
    this.taskId = params.taskId;
    this.runId = params.runId;
  }
}
