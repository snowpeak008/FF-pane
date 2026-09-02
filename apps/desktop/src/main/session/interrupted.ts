/**
 * 被中断的 Worker 轮 → Run(interrupted) + 任务 failed 的纯逻辑（T8.2b）。
 *
 * 退出钩子（编排器 prepareForQuit，轮次仍在内存里）与启动修正（repair.ts，只剩磁盘上的
 * 标记）是同一件事的两个入口：都要"替没来得及收尾的 Worker 轮补一条 Run、把任务从
 * running 拉回 failed"。把这一步抽成纯函数，两个入口就不会各自演化出两套 attempt 递增
 * 或证据形状。零 IO：Run 读写与任务落盘由调用方做。
 */

import { endRun, settleTaskAfterRun, startRun } from "@ff-pane/core";
import type {
  CommandRecord,
  EpochMillis,
  FileChange,
  ProfileId,
  Run,
  RunId,
  Task,
} from "@ff-pane/shared";

/** buildInterruptedRun 的输入。 */
export interface InterruptedRunInput {
  /** 被中断时仍处于 running 的任务（调用方已确认状态）。 */
  readonly task: Task;
  /** 新 Run 的 ID。 */
  readonly runId: RunId;
  readonly profileId: ProfileId;
  /** 轮开始时刻（来自在飞标记 / WorkerContext）。 */
  readonly startedAt: EpochMillis;
  /** 中断落盘时刻。 */
  readonly endedAt: EpochMillis;
  /** 该项目已有的全部 Run（attempt 递增依据）。 */
  readonly existingRuns: readonly Run[];
  /** 抢救下来的部分 assistant 文本；空白则 Run 不带 report。 */
  readonly partialReport: string;
  /** 退出钩子路径可给出的已累积证据；启动修正路径拿不到，缺省即空。 */
  readonly fileChanges?: readonly FileChange[];
  readonly commands?: readonly CommandRecord[];
}

/** buildInterruptedRun 的产出：可直接落盘的 Run 与推进后的任务。 */
export interface InterruptedRunOutcome {
  readonly run: Run;
  readonly task: Task;
}

/**
 * 铸一条 endReason=interrupted 的已结束 Run，并按联动规则把任务推到 failed（可重试）。
 * 走 core 的 startRun / endRun / settleTaskAfterRun 而不是手拼对象：attempt 序号、
 * 「同一任务只能有一条在飞 Run」、联动规则都只在 core 定义一次。
 * 任务非 running 或已有在飞 Run 时 core 会抛 RunLifecycleError，由调用方决定处置。
 */
export function buildInterruptedRun(input: InterruptedRunInput): InterruptedRunOutcome {
  const started = startRun(input.task, {
    id: input.runId,
    profileId: input.profileId,
    startedAt: input.startedAt,
    rawLogPath: "raw.log",
    existingRuns: input.existingRuns,
  });
  const report = input.partialReport.trim();
  const run = endRun(started, {
    endedAt: input.endedAt,
    endReason: "interrupted",
    ...(input.fileChanges !== undefined ? { fileChanges: input.fileChanges } : {}),
    ...(input.commands !== undefined ? { commands: input.commands } : {}),
    ...(report.length > 0 ? { report } : {}),
  });
  return { run, task: settleTaskAfterRun(input.task, run, "fail-task") };
}
