/**
 * Task 状态迁移函数（W1.4b，设计文档 §6.3 / §6.5 / §11.4）。
 * 每个函数只承认自己负责的边（迁移表 + 函数级来源约束双重把关），
 * 非法迁移一律抛 InvalidTaskTransitionError，不静默忽略。
 * 全部纯函数：不改入参，返回新 Task（字段 readonly，更新走 spread）。
 */

import type { Run, Task, TaskStatus } from "@ff-pane/shared";
import type { TaskTransitionAction } from "./errors.js";
import {
  DoneEvidenceError,
  InvalidTaskTransitionError,
  UnauthorizedTaskActorError,
} from "./errors.js";
import type {
  BlockedTask,
  DoneEvidenceKind,
  DoneTask,
  TaskActor,
  TaskBlockReason,
} from "./model.js";
import { isRunEnded } from "./model.js";
import { canTransitionTask } from "./transitions.js";

/** 函数级迁移断言：来源必须在本函数认领的边内，且迁移表允许。 */
function assertTransition(
  task: Task,
  allowedFrom: readonly TaskStatus[],
  to: TaskStatus,
  action: TaskTransitionAction,
): void {
  if (!allowedFrom.includes(task.status) || !canTransitionTask(task.status, to)) {
    throw new InvalidTaskTransitionError({ taskId: task.id, from: task.status, to, action });
  }
}

/**
 * 派发：pending→running；failed→running（重试 = 再次派发，§11.4 任务页"重试"按钮）。
 * 只迁移状态，新 Run 由 startRun 铸造——重试产生新 Run 的约定见 §6.3 / §6.4。
 */
export function dispatchTask(task: Task): Task {
  assertTransition(task, ["pending", "failed"], "running", "dispatchTask");
  return { ...task, status: "running" };
}

/**
 * 阻塞：running→blocked。成因限定为澄清请求（§6.5）或权限扩展请求（§7），
 * 原因以 blockReason 标记留在 Task 上，供任务页置顶展示待答请求（§11.4）。
 * 请求记录本体（ClarificationRequest / 权限请求）由编排层另行持久化。
 */
export function blockTask(task: Task, reason: TaskBlockReason): BlockedTask {
  assertTransition(task, ["running"], "blocked", "blockTask");
  return { ...task, status: "blocked", blockReason: reason };
}

/**
 * 恢复：blocked→running（澄清已回答 / 权限已批复，§6.3）。
 * 权限被拒同样走本函数回 running——拒绝也是一种答复，Run 仍在飞，
 * 由 Worker 决定后续（换路或失败）。恢复时移除 blockReason 标记（答复已消化）。
 * 答复记录本身（如 ClarificationRequest.answer 在场）的校验在编排层，纯状态机不读存储。
 */
export function resumeTask(task: Task): Task {
  assertTransition(task, ["blocked"], "running", "resumeTask");
  const { blockReason: _blockReason, ...rest } = task as Task & {
    readonly blockReason?: TaskBlockReason;
  };
  return { ...rest, status: "running" };
}

/** 失败：running→failed（可重试，重试经 dispatchTask + startRun 产生新 Run，§6.3）。 */
export function failTask(task: Task): Task {
  assertTransition(task, ["running"], "failed", "failTask");
  return { ...task, status: "failed" };
}

/**
 * 完成：running→done，必须携带证据（W1.4b 定义的 done 判定规则，权威版）。
 *
 * done 的语义（§6.3）：Worker 声称完成且验证命令通过。本函数把该语义落为硬约束：
 * 1. 证据载体是本任务的一条已结束 Run：run.taskId 与任务一致、
 *    endedAt/endReason 成对在场且 endReason === "completed"。没有 completed Run
 *    就没有 done。
 * 2. 任务合同带 verifyCmd（§6.2）时：Run.verifyResult 必须在场、其 command 必须与
 *    合同 verifyCmd 完全一致（防止拿别的命令的输出充数）、exitCode === 0
 *    （§6.4：通过与否 = exitCode === 0）。落 "verify-cmd-passed" 标记。
 * 3. 任务合同无 verifyCmd（如纯文档任务）时：Run.report（Worker 完成报告）必须在场
 *    且非空白。落 "report-unverified" 显式标记——未经命令验证的 done，
 *    UI 与 Reviewer 据此识别（§11.4 / §11.5）。
 * 4. 不存在第三条路径：无证据或证据不合格的 done 一律拒绝
 *    （DoneEvidenceError，reason 指明具体缺口）。
 */
export function completeTask(task: Task, run: Run): DoneTask {
  assertTransition(task, ["running"], "done", "completeTask");
  if (run.taskId !== task.id) {
    throw new DoneEvidenceError({ taskId: task.id, runId: run.id, reason: "run-task-mismatch" });
  }
  if (!isRunEnded(run) || run.endReason !== "completed") {
    throw new DoneEvidenceError({ taskId: task.id, runId: run.id, reason: "run-not-completed" });
  }
  if (task.verifyCmd !== undefined) {
    const verify = run.verifyResult;
    if (verify === undefined) {
      throw new DoneEvidenceError({
        taskId: task.id,
        runId: run.id,
        reason: "verify-result-missing",
      });
    }
    if (verify.command !== task.verifyCmd) {
      throw new DoneEvidenceError({
        taskId: task.id,
        runId: run.id,
        reason: "verify-command-mismatch",
      });
    }
    if (verify.exitCode !== 0) {
      throw new DoneEvidenceError({ taskId: task.id, runId: run.id, reason: "verify-cmd-failed" });
    }
    return { ...task, status: "done", doneEvidence: "verify-cmd-passed" };
  }
  if (run.report === undefined || run.report.trim() === "") {
    throw new DoneEvidenceError({ taskId: task.id, runId: run.id, reason: "report-missing" });
  }
  return { ...task, status: "done", doneEvidence: "report-unverified" };
}

/**
 * 验收：done→accepted（终态）。仅限用户动作——done ≠ accepted 是产品核心原则（§6.3），
 * 任何 Agent 角色（planner/worker/reviewer）与系统自动流程都无权验收；
 * "Reviewer + 用户"模式下 Reviewer 的结论也只是供用户参考。
 * 授权检查先于状态检查：非用户动作方连状态信息都不该借错误反推。
 * doneEvidence 标记原样保留，验收后仍可审计完成方式。
 */
export function acceptTask(task: Task, actor: TaskActor): Task {
  if (actor !== "user") {
    throw new UnauthorizedTaskActorError({ taskId: task.id, action: "acceptTask", actor });
  }
  assertTransition(task, ["done"], "accepted", "acceptTask");
  return { ...task, status: "accepted" };
}

/**
 * 取消：pending/running/blocked/failed/done→cancelled（终态，§6.3）。
 * 扩展标记（blockReason/doneEvidence）保留在终态记录上供审计。
 * 取消时若有在飞 Run，编排层负责随后 endRun(..., "cancelled")；纯状态机不管 IO 时序。
 */
export function cancelTask(task: Task): Task {
  assertTransition(
    task,
    ["pending", "running", "blocked", "failed", "done"],
    "cancelled",
    "cancelTask",
  );
  return { ...task, status: "cancelled" };
}

/**
 * 返工：done→running（用户要求返工，§6.3）。移除 doneEvidence 标记——
 * 原完成证据随返工作废，重新完成必须重新过 completeTask 的证据校验。
 * 后续执行须经 startRun 铸造新 Run（原 Run 已结束）。
 */
export function reworkTask(task: Task): Task {
  assertTransition(task, ["done"], "running", "reworkTask");
  const { doneEvidence: _doneEvidence, ...rest } = task as Task & {
    readonly doneEvidence?: DoneEvidenceKind;
  };
  return { ...rest, status: "running" };
}
