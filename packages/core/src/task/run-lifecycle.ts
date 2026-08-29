/**
 * Run 生命周期（W1.4b，设计文档 §6.4）。纯逻辑零 IO：ID、时钟、日志路径由调用方注入。
 *
 * Run 与 Task 的联动设计（W1.4b 设计决策）：
 * - 新 Run 只在任务处于 running 且无在飞 Run 时铸造（startRun）。派发/重试/返工
 *   先走任务迁移函数把状态推到 running 再 startRun——进入执行的状态门槛
 *   单一事实来源在迁移表，startRun 不重复承担迁移职责。
 * - blocked 不结束 Run：澄清/权限等待期间 Run 仍在飞（§7"批准仅对当前 Run 有效"
 *   即以 Run 为授权边界），resumeTask 恢复后继续同一条 Run。因此 blocked 期间
 *   startRun 会因在飞 Run 被拒——这正是"同一任务同时只有一个进行中 Run"的体现。
 * - attempt 从 1 起、按该任务历史最大值 +1 递增（§6.4 序号），历史有跳号也不回填。
 */

import type {
  CommandRecord,
  EpochMillis,
  FileChange,
  ProfileId,
  Run,
  RunEndReason,
  RunId,
  Task,
  VerifyResult,
} from "@ff-pane/shared";
import { RunLifecycleError } from "./errors.js";
import type { EndedRun } from "./model.js";
import { isRunEnded, isRunInFlight } from "./model.js";
import { cancelTask, completeTask, failTask } from "./task-machine.js";

/** startRun 的输入：纯逻辑零 IO，ID 与时钟由调用方生成后注入。 */
export interface StartRunParams {
  /** 新 Run 的 ID。 */
  readonly id: RunId;
  /** 设计文档 §6.4 —— 用哪个 Agent Profile 执行。 */
  readonly profileId: ProfileId;
  /** 开始时间（epoch 毫秒）。 */
  readonly startedAt: EpochMillis;
  /** 设计文档 §6.4 —— 原始日志文件路径。 */
  readonly rawLogPath: string;
  /** 该任务已有的全部 Run 记录（并发检查与 attempt 递增依据；其他任务的记录被忽略）。 */
  readonly existingRuns: readonly Run[];
}

/**
 * 铸造新 Run：校验任务状态可执行（running，即已派发/已返工）、
 * 同一任务同时只有一个进行中 Run（半写损坏记录同样按在飞对待，宁可拒绝也不并发）。
 * 证据字段初始化为空，执行过程中由适配器累积、结束时经 endRun 汇总落定。
 */
export function startRun(task: Task, params: StartRunParams): Run {
  if (task.status !== "running") {
    throw new RunLifecycleError({ reason: "task-not-running", taskId: task.id });
  }
  const taskRuns = params.existingRuns.filter((run) => run.taskId === task.id);
  const inFlight = taskRuns.find((run) => !isRunEnded(run));
  if (inFlight !== undefined) {
    throw new RunLifecycleError({ reason: "concurrent-run", taskId: task.id, runId: inFlight.id });
  }
  const attempt = taskRuns.reduce((max, run) => Math.max(max, run.attempt), 0) + 1;
  return {
    id: params.id,
    taskId: task.id,
    attempt,
    profileId: params.profileId,
    startedAt: params.startedAt,
    fileChanges: [],
    commands: [],
    rawLogPath: params.rawLogPath,
  };
}

/** endRun 的输入：结束时刻 + 结束原因 + 结束时汇总的证据。 */
export interface EndRunParams {
  /** 结束时间；与 endReason 成对写入（§6.4），本模块不提供只写其一的途径。 */
  readonly endedAt: EpochMillis;
  /** 设计文档 §6.4 —— end_reason。 */
  readonly endReason: RunEndReason;
  /** 结束时汇总的文件修改；缺省保留 Run 上已累积的记录。 */
  readonly fileChanges?: readonly FileChange[];
  /** 结束时汇总的命令记录；缺省保留 Run 上已累积的记录。 */
  readonly commands?: readonly CommandRecord[];
  /** 验证命令输出（跑了验证才有，§6.4）。 */
  readonly verifyResult?: VerifyResult;
  /** Worker 完成报告（产出了才有，§6.4）。 */
  readonly report?: string;
}

/**
 * 结束 Run：endedAt 与 endReason 一次性成对写入，返回 EndedRun。
 * 只接受在飞 Run——已结束（不可二次结束）与半写损坏记录一律拒绝。
 * 注意 endRun 只保证记录完整性，不做 done 门槛判定：completed 的 Run
 * 是否足以支撑任务 done，由 completeTask 的证据规则裁决。
 */
export function endRun(run: Run, params: EndRunParams): EndedRun {
  if (!isRunInFlight(run)) {
    throw new RunLifecycleError({ reason: "run-not-in-flight", taskId: run.taskId, runId: run.id });
  }
  return {
    ...run,
    endedAt: params.endedAt,
    endReason: params.endReason,
    fileChanges: params.fileChanges ?? run.fileChanges,
    commands: params.commands ?? run.commands,
    ...(params.verifyResult !== undefined ? { verifyResult: params.verifyResult } : {}),
    ...(params.report !== undefined ? { report: params.report } : {}),
  };
}

/**
 * Run 终态对 Task 状态的联动规则（数据形式，W1.4b 设计决策）：
 * - completed → "complete"：候选 done，仍须过 completeTask 的证据校验，不自动 done；
 * - failed / crashed → "fail"：任务转 failed（可重试）；崩溃与失败对任务同义，
 *   差异只体现在 Run.endReason 供排查；
 * - cancelled → "caller-decides"：由调用方在 cancelTask（放弃任务，终态）与
 *   failTask（视作一次未完成的尝试，任务保留且可重试）之间二选一。
 *   不提供"回 pending"：迁移表没有 running→pending 边，pending 专指"从未派发"；
 *   已派发过的任务用 failed→dispatchTask 表达"回队列重来"，历史 Run 归属不被抹除。
 */
export const RUN_END_TASK_LINKAGE = {
  completed: "complete",
  failed: "fail",
  crashed: "fail",
  cancelled: "caller-decides",
} as const satisfies Record<RunEndReason, "complete" | "fail" | "caller-decides">;

/** Run 被取消时对任务的处置：放弃任务（终态）或记一次失败（保留重试）。 */
export type CancelledRunPolicy = "cancel-task" | "fail-task";

/**
 * 按联动规则把已结束 Run 的结果落到任务状态上（RUN_END_TASK_LINKAGE 的可执行形式）。
 * 前置：run 属于该任务且已结束；任务处于 running（blocked 场景先 resumeTask
 * 或直接 cancelTask，联动不代办）。completed 分支透传 completeTask 的证据校验，
 * 证据不合格时 DoneEvidenceError 原样抛出，任务留在 running 由调用方决定 fail 或补证。
 */
export function settleTaskAfterRun(
  task: Task,
  run: Run,
  cancelledPolicy: CancelledRunPolicy,
): Task {
  if (run.taskId !== task.id) {
    throw new RunLifecycleError({ reason: "run-task-mismatch", taskId: task.id, runId: run.id });
  }
  if (!isRunEnded(run)) {
    throw new RunLifecycleError({ reason: "run-not-ended", taskId: task.id, runId: run.id });
  }
  switch (run.endReason) {
    case "completed":
      return completeTask(task, run);
    case "failed":
    case "crashed":
      return failTask(task);
    case "cancelled":
      return cancelledPolicy === "cancel-task" ? cancelTask(task) : failTask(task);
  }
}
