/**
 * 任务卡片的审查态派生（T7.2，设计文档 §3.1）。
 *
 * 与 React 无关，便于单测。本文件不含任何面向用户的文案——措辞一律由调用方经语言包取。
 *
 * ## 为什么由 Run 派生而不是在 Task 上存一个字段
 * 审查结论是**对某一次尝试**的判断（§6.4 Run = 一次尝试），而任务可以有多条 Run。
 * 在 Task 上存一个 verdict，等于要求某处代码去回答"多条 Run 各有结论时任务算什么"——
 * 那个问题没有正确答案，只有一个会随时间腐坏的近似。任务卡片要的其实是很具体的一件事：
 * **最后那次尝试审过没有、结论是什么**，从 runs 列表当场算得出来，且永远与事实一致。
 * 这与 §11.1「项目卡片派生信息不持久化」是同一条原则。
 */

import type { ReviewVerdict, Run, Task } from "@ff-pane/shared";

/** 一个任务的审查态。 */
export interface TaskReviewState {
  /** 最近一次尝试（按 attempt 取最大；该任务尚无 Run 时缺省）。 */
  readonly latestRun?: Run;
  /** 最近一次尝试的审查结论（未审查过时缺省）。 */
  readonly verdict?: ReviewVerdict;
}

/**
 * 从项目全部 Run 中派生某任务的审查态。
 *
 * 取 attempt 最大者而非数组末位：`runs:list` 的顺序由目录枚举决定（run-<uuid> 的
 * 字典序），与尝试先后无关。attempt 是 startRun 递增出来的，它才是"第几次"。
 */
export function deriveTaskReview(task: Task, runs: readonly Run[]): TaskReviewState {
  let latestRun: Run | undefined;
  for (const run of runs) {
    if (run.taskId !== task.id) {
      continue;
    }
    if (latestRun === undefined || run.attempt > latestRun.attempt) {
      latestRun = run;
    }
  }
  if (latestRun === undefined) {
    return {};
  }
  const verdict = latestRun.review?.verdict;
  return {
    latestRun,
    ...(verdict !== undefined ? { verdict } : {}),
  };
}

/**
 * 该任务此刻能不能发起审查。
 *
 * `done` 而非"任意状态"：§3.1 写的是「对照验收标准审查 Worker 产出」，产出要先存在。
 * 也**不**限定"未审查过"——重审是正当需求（Reviewer 换了、或用户不信第一次的结论），
 * 结论覆盖式更新（见 Run.review 注释）。
 *
 * 终态 accepted 之后不再放行：任务已由用户拍板接受，此时一份 fail 结论既改不了状态
 * （acceptTask 不可逆），也只会让记录自相矛盾。要重审得先返工。
 */
export function canReviewTask(task: Task, state: TaskReviewState): boolean {
  return task.status === "done" && state.latestRun !== undefined;
}
