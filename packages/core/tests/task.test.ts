/**
 * W1.4b —— Task 状态机 + Run 生命周期单测。
 * 覆盖：7×7 迁移全矩阵、done 判定双路径与无证据拒绝、acceptTask 仅限用户、
 * 单任务并发 Run 拒绝、endedAt/endReason 成对性、Run 终态与 Task 联动。
 */

import type { PlanVersion, ProfileId, Run, RunId, Task, TaskId, TaskStatus } from "@ff-pane/shared";
import { TASK_STATUSES } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  acceptTask,
  blockTask,
  cancelTask,
  canTransitionTask,
  completeTask,
  DoneEvidenceError,
  dispatchTask,
  endRun,
  failTask,
  InvalidTaskTransitionError,
  isRunEnded,
  isRunInFlight,
  RUN_END_TASK_LINKAGE,
  RunLifecycleError,
  resumeTask,
  reworkTask,
  settleTaskAfterRun,
  startRun,
  TASK_ACTORS,
  TASK_TRANSITION_TABLE,
  UnauthorizedTaskActorError,
} from "../src/index.js";

const TASK_ID = "task-001" as TaskId;
const OTHER_TASK_ID = "task-002" as TaskId;
const PROFILE_ID = "profile-worker" as ProfileId;
const VERIFY_CMD = "pnpm test";

function makeTask(status: TaskStatus, overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    planVersion: 1 as PlanVersion,
    goal: "实现登录表单",
    writeScope: ["src/auth/**"],
    forbidden: ["不得改动数据库 schema"],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["表单可提交"],
    status,
    ...overrides,
  };
}

let runSeq = 0;
function makeRun(overrides: Partial<Run> = {}): Run {
  runSeq += 1;
  return {
    id: `run-${runSeq}` as RunId,
    taskId: TASK_ID,
    attempt: 1,
    profileId: PROFILE_ID,
    startedAt: 1_000,
    fileChanges: [],
    commands: [],
    rawLogPath: `runs/run-${runSeq}/raw.log`,
    ...overrides,
  };
}

/** completed Run，带 Worker 报告（无 verifyCmd 任务的 done 证据）。 */
function completedRunWithReport(overrides: Partial<Run> = {}): Run {
  return makeRun({
    endedAt: 2_000,
    endReason: "completed",
    report: "已完成，详见 diff",
    ...overrides,
  });
}

/** completed Run，带通过的验证结果（有 verifyCmd 任务的 done 证据）。 */
function completedRunWithVerify(overrides: Partial<Run> = {}): Run {
  return makeRun({
    endedAt: 2_000,
    endReason: "completed",
    verifyResult: { command: VERIFY_CMD, exitCode: 0, output: "all passed" },
    ...overrides,
  });
}

/** 捕获期望的类型化错误并返回，便于断言结构化字段。 */
function grab<T extends Error>(fn: () => unknown, ctor: new (...args: never[]) => T): T {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ctor);
    return error as T;
  }
  throw new Error("expected function to throw");
}

/** 每条合法边与负责它的迁移函数（矩阵测试的驱动器）。 */
interface EdgeDriver {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly via: string;
  readonly drive: (task: Task) => Task;
}

const EDGE_DRIVERS: readonly EdgeDriver[] = [
  { from: "pending", to: "running", via: "dispatchTask", drive: (t) => dispatchTask(t) },
  { from: "failed", to: "running", via: "dispatchTask(重试)", drive: (t) => dispatchTask(t) },
  { from: "blocked", to: "running", via: "resumeTask", drive: (t) => resumeTask(t) },
  { from: "done", to: "running", via: "reworkTask", drive: (t) => reworkTask(t) },
  { from: "running", to: "blocked", via: "blockTask", drive: (t) => blockTask(t, "clarification") },
  { from: "running", to: "failed", via: "failTask", drive: (t) => failTask(t) },
  {
    from: "running",
    to: "done",
    via: "completeTask",
    drive: (t) => completeTask(t, completedRunWithReport()),
  },
  { from: "done", to: "accepted", via: "acceptTask", drive: (t) => acceptTask(t, "user") },
  { from: "pending", to: "cancelled", via: "cancelTask", drive: (t) => cancelTask(t) },
  { from: "running", to: "cancelled", via: "cancelTask", drive: (t) => cancelTask(t) },
  { from: "blocked", to: "cancelled", via: "cancelTask", drive: (t) => cancelTask(t) },
  { from: "failed", to: "cancelled", via: "cancelTask", drive: (t) => cancelTask(t) },
  { from: "done", to: "cancelled", via: "cancelTask", drive: (t) => cancelTask(t) },
];

/** 每个迁移函数认领的来源状态（非法来源全部应拒绝）。 */
interface FunctionSpec {
  readonly name: string;
  readonly allowedFrom: readonly TaskStatus[];
  readonly invoke: (task: Task) => unknown;
}

const FUNCTION_SPECS: readonly FunctionSpec[] = [
  { name: "dispatchTask", allowedFrom: ["pending", "failed"], invoke: (t) => dispatchTask(t) },
  { name: "blockTask", allowedFrom: ["running"], invoke: (t) => blockTask(t, "permission") },
  { name: "resumeTask", allowedFrom: ["blocked"], invoke: (t) => resumeTask(t) },
  { name: "failTask", allowedFrom: ["running"], invoke: (t) => failTask(t) },
  {
    name: "completeTask",
    allowedFrom: ["running"],
    invoke: (t) => completeTask(t, completedRunWithReport()),
  },
  { name: "acceptTask", allowedFrom: ["done"], invoke: (t) => acceptTask(t, "user") },
  { name: "reworkTask", allowedFrom: ["done"], invoke: (t) => reworkTask(t) },
  {
    name: "cancelTask",
    allowedFrom: ["pending", "running", "blocked", "failed", "done"],
    invoke: (t) => cancelTask(t),
  },
];

describe("迁移表（7×7 全矩阵）", () => {
  it("迁移表与设计文档 §6.3 的边完全一致", () => {
    expect(TASK_TRANSITION_TABLE).toEqual({
      pending: ["running", "cancelled"],
      running: ["blocked", "failed", "done", "cancelled"],
      blocked: ["running", "cancelled"],
      failed: ["running", "cancelled"],
      done: ["accepted", "running", "cancelled"],
      accepted: [],
      cancelled: [],
    });
  });

  it("canTransitionTask 覆盖全部 49 个组合，合法边恰为 13 条", () => {
    let legal = 0;
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const expected = TASK_TRANSITION_TABLE[from].includes(to);
        expect(canTransitionTask(from, to), `${from} -> ${to}`).toBe(expected);
        if (expected) {
          legal += 1;
        }
      }
    }
    expect(legal).toBe(13);
  });

  it("终态 accepted / cancelled 零出边，自环全部非法", () => {
    for (const to of TASK_STATUSES) {
      expect(canTransitionTask("accepted", to)).toBe(false);
      expect(canTransitionTask("cancelled", to)).toBe(false);
    }
    for (const status of TASK_STATUSES) {
      expect(canTransitionTask(status, status)).toBe(false);
    }
  });

  it("每条合法边有且仅有一个迁移函数认领，非法边零认领", () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const drivers = EDGE_DRIVERS.filter((d) => d.from === from && d.to === to);
        expect(drivers.length, `${from} -> ${to}`).toBe(canTransitionTask(from, to) ? 1 : 0);
      }
    }
  });

  for (const { from, to, via, drive } of EDGE_DRIVERS) {
    it(`合法边 ${from} → ${to}（${via}）迁移成功且不改入参`, () => {
      const before = makeTask(from);
      const after = drive(before);
      expect(after.status).toBe(to);
      expect(after).not.toBe(before);
      expect(before.status).toBe(from);
    });
  }

  for (const spec of FUNCTION_SPECS) {
    const illegalFrom = TASK_STATUSES.filter((s) => !spec.allowedFrom.includes(s));
    it(`${spec.name} 拒绝非法来源：${illegalFrom.join(" / ")}`, () => {
      for (const from of illegalFrom) {
        expect(() => spec.invoke(makeTask(from)), `${spec.name} from ${from}`).toThrow(
          InvalidTaskTransitionError,
        );
      }
    });
  }

  it("非法迁移错误携带 taskId / from / to / action", () => {
    const error = grab(() => dispatchTask(makeTask("running")), InvalidTaskTransitionError);
    expect(error.code).toBe("task-transition-invalid");
    expect(error.taskId).toBe(TASK_ID);
    expect(error.from).toBe("running");
    expect(error.to).toBe("running");
    expect(error.action).toBe("dispatchTask");
  });
});

describe("done 判定规则", () => {
  it("有 verifyCmd：验证命令一致且退出码 0 → done，标记 verify-cmd-passed", () => {
    const task = makeTask("running", { verifyCmd: VERIFY_CMD });
    const done = completeTask(task, completedRunWithVerify());
    expect(done.status).toBe("done");
    expect(done.doneEvidence).toBe("verify-cmd-passed");
  });

  it("有 verifyCmd：缺 VerifyResult 拒绝，即便带了 Worker 报告也不能充数", () => {
    const task = makeTask("running", { verifyCmd: VERIFY_CMD });
    const error = grab(() => completeTask(task, completedRunWithReport()), DoneEvidenceError);
    expect(error.reason).toBe("verify-result-missing");
  });

  it("有 verifyCmd：验证命令与合同不一致拒绝", () => {
    const task = makeTask("running", { verifyCmd: VERIFY_CMD });
    const run = completedRunWithVerify({
      verifyResult: { command: "echo ok", exitCode: 0, output: "ok" },
    });
    const error = grab(() => completeTask(task, run), DoneEvidenceError);
    expect(error.reason).toBe("verify-command-mismatch");
  });

  it("有 verifyCmd：验证命令退出码非 0 拒绝", () => {
    const task = makeTask("running", { verifyCmd: VERIFY_CMD });
    const run = completedRunWithVerify({
      verifyResult: { command: VERIFY_CMD, exitCode: 1, output: "1 failed" },
    });
    const error = grab(() => completeTask(task, run), DoneEvidenceError);
    expect(error.reason).toBe("verify-cmd-failed");
  });

  it("无 verifyCmd：Worker 报告 + completed Run → done，显式标记 report-unverified", () => {
    const done = completeTask(makeTask("running"), completedRunWithReport());
    expect(done.status).toBe("done");
    expect(done.doneEvidence).toBe("report-unverified");
  });

  it("无 verifyCmd：缺报告或报告空白一律拒绝（不允许无证据的 done）", () => {
    const noReport = makeRun({ endedAt: 2_000, endReason: "completed" });
    expect(grab(() => completeTask(makeTask("running"), noReport), DoneEvidenceError).reason).toBe(
      "report-missing",
    );
    const blankReport = completedRunWithReport({ report: "   \n  " });
    expect(
      grab(() => completeTask(makeTask("running"), blankReport), DoneEvidenceError).reason,
    ).toBe("report-missing");
  });

  it("证据 Run 必须已结束且 endReason 为 completed", () => {
    const inFlight = makeRun({ report: "声称完成但 Run 还在飞" });
    expect(grab(() => completeTask(makeTask("running"), inFlight), DoneEvidenceError).reason).toBe(
      "run-not-completed",
    );
    const failedRun = makeRun({ endedAt: 2_000, endReason: "failed", report: "失败了" });
    expect(grab(() => completeTask(makeTask("running"), failedRun), DoneEvidenceError).reason).toBe(
      "run-not-completed",
    );
  });

  it("证据 Run 必须属于该任务", () => {
    const foreignRun = completedRunWithReport({ taskId: OTHER_TASK_ID });
    const error = grab(() => completeTask(makeTask("running"), foreignRun), DoneEvidenceError);
    expect(error.reason).toBe("run-task-mismatch");
  });
});

describe("acceptTask 仅限用户", () => {
  it("用户验收 done 任务 → accepted，doneEvidence 标记保留供审计", () => {
    const done = completeTask(makeTask("running"), completedRunWithReport());
    const accepted = acceptTask(done, "user");
    expect(accepted.status).toBe("accepted");
    expect((accepted as typeof done).doneEvidence).toBe("report-unverified");
  });

  it("非用户动作方（planner/worker/reviewer/system）一律拒绝", () => {
    const done = completeTask(makeTask("running"), completedRunWithReport());
    for (const actor of TASK_ACTORS.filter((a) => a !== "user")) {
      const error = grab(() => acceptTask(done, actor), UnauthorizedTaskActorError);
      expect(error.code).toBe("task-actor-unauthorized");
      expect(error.actor).toBe(actor);
      expect(error.action).toBe("acceptTask");
    }
  });

  it("授权检查先于状态检查：非用户对非 done 任务也报未授权", () => {
    expect(() => acceptTask(makeTask("pending"), "worker")).toThrow(UnauthorizedTaskActorError);
  });
});

describe("扩展标记的写入与清理", () => {
  it("blockTask 写入 blockReason（澄清 / 权限），resumeTask 恢复时移除", () => {
    const blocked = blockTask(makeTask("running"), "clarification");
    expect(blocked.blockReason).toBe("clarification");
    expect(blockTask(makeTask("running"), "permission").blockReason).toBe("permission");
    const resumed = resumeTask(blocked);
    expect(resumed.status).toBe("running");
    expect("blockReason" in resumed).toBe(false);
  });

  it("reworkTask 移除 doneEvidence——原完成证据随返工作废", () => {
    const done = completeTask(makeTask("running"), completedRunWithReport());
    const reworked = reworkTask(done);
    expect(reworked.status).toBe("running");
    expect("doneEvidence" in reworked).toBe(false);
  });

  it("cancelTask 保留标记在终态记录上供审计", () => {
    const blocked = blockTask(makeTask("running"), "permission");
    const cancelled = cancelTask(blocked);
    expect(cancelled.status).toBe("cancelled");
    expect((cancelled as typeof blocked).blockReason).toBe("permission");
  });
});

describe("Run 生命周期", () => {
  const startParams = {
    id: "run-new" as RunId,
    profileId: PROFILE_ID,
    startedAt: 5_000,
    rawLogPath: "runs/run-new/raw.log",
  };

  it("startRun 铸造首个 Run：attempt 为 1、证据字段为空、结束字段缺席", () => {
    const run = startRun(makeTask("running"), { ...startParams, existingRuns: [] });
    expect(run).toEqual({
      id: "run-new",
      taskId: TASK_ID,
      attempt: 1,
      profileId: PROFILE_ID,
      startedAt: 5_000,
      fileChanges: [],
      commands: [],
      rawLogPath: "runs/run-new/raw.log",
    });
    expect(isRunInFlight(run)).toBe(true);
    expect(isRunEnded(run)).toBe(false);
  });

  it("attempt 按该任务历史最大值 +1 递增，跳号不回填", () => {
    const history = [
      makeRun({ attempt: 1, endedAt: 2_000, endReason: "failed" }),
      makeRun({ attempt: 5, endedAt: 3_000, endReason: "failed" }),
    ];
    const run = startRun(makeTask("running"), { ...startParams, existingRuns: history });
    expect(run.attempt).toBe(6);
  });

  it("任务未处于 running（未派发）时拒绝铸造 Run", () => {
    for (const status of TASK_STATUSES.filter((s) => s !== "running")) {
      const error = grab(
        () => startRun(makeTask(status), { ...startParams, existingRuns: [] }),
        RunLifecycleError,
      );
      expect(error.reason, `startRun from ${status}`).toBe("task-not-running");
    }
  });

  it("同一任务已有在飞 Run 时拒绝并发，错误指明冲突 Run", () => {
    const inFlight = makeRun();
    const error = grab(
      () => startRun(makeTask("running"), { ...startParams, existingRuns: [inFlight] }),
      RunLifecycleError,
    );
    expect(error.reason).toBe("concurrent-run");
    expect(error.runId).toBe(inFlight.id);
  });

  it("半写损坏记录（只有 endedAt 或只有 endReason）按在飞对待，同样挡住新 Run", () => {
    const corruptA = makeRun({ endedAt: 2_000 });
    const corruptB = makeRun({ endReason: "failed" });
    for (const corrupt of [corruptA, corruptB]) {
      expect(isRunEnded(corrupt)).toBe(false);
      expect(isRunInFlight(corrupt)).toBe(false);
      expect(() =>
        startRun(makeTask("running"), { ...startParams, existingRuns: [corrupt] }),
      ).toThrow(RunLifecycleError);
    }
  });

  it("其他任务的在飞 Run 不影响本任务：可并行铸造且 attempt 独立", () => {
    const foreignInFlight = makeRun({ taskId: OTHER_TASK_ID, attempt: 9 });
    const run = startRun(makeTask("running"), {
      ...startParams,
      existingRuns: [foreignInFlight],
    });
    expect(run.attempt).toBe(1);
  });

  it("endRun 成对写入 endedAt 与 endReason", () => {
    const ended = endRun(makeRun(), { endedAt: 9_000, endReason: "failed" });
    expect(ended.endedAt).toBe(9_000);
    expect(ended.endReason).toBe("failed");
    expect(isRunEnded(ended)).toBe(true);
    expect(isRunInFlight(ended)).toBe(false);
  });

  it("endRun 证据汇总：提供则落定，缺省保留 Run 已累积的记录、可选字段不凭空出现", () => {
    const run = makeRun({ commands: [{ command: "pnpm lint", exitCode: 0 }] });
    const ended = endRun(run, {
      endedAt: 9_000,
      endReason: "completed",
      fileChanges: [{ path: "src/auth/form.ts", diff: "+ export const form = 1;" }],
      verifyResult: { command: VERIFY_CMD, exitCode: 0, output: "all passed" },
      report: "完成",
    });
    expect(ended.fileChanges).toHaveLength(1);
    expect(ended.commands).toEqual(run.commands);
    expect(ended.verifyResult?.exitCode).toBe(0);
    expect(ended.report).toBe("完成");

    const bare = endRun(makeRun(), { endedAt: 9_000, endReason: "cancelled" });
    expect("verifyResult" in bare).toBe(false);
    expect("report" in bare).toBe(false);
  });

  it("endRun 拒绝二次结束与半写损坏记录（成对性不可破坏）", () => {
    const ended = endRun(makeRun(), { endedAt: 9_000, endReason: "completed" });
    expect(
      grab(() => endRun(ended, { endedAt: 9_500, endReason: "failed" }), RunLifecycleError).reason,
    ).toBe("run-not-in-flight");
    const corrupt = makeRun({ endedAt: 2_000 });
    expect(
      grab(() => endRun(corrupt, { endedAt: 9_000, endReason: "failed" }), RunLifecycleError)
        .reason,
    ).toBe("run-not-in-flight");
  });
});

describe("Run 终态与 Task 状态联动", () => {
  it("联动规则表：completed→complete、failed/crashed/interrupted→fail、cancelled→caller-decides", () => {
    expect(RUN_END_TASK_LINKAGE).toEqual({
      completed: "complete",
      failed: "fail",
      crashed: "fail",
      interrupted: "fail",
      cancelled: "caller-decides",
    });
  });

  it("completed Run + 合格证据 → done（不绕过 completeTask 的证据校验）", () => {
    const settled = settleTaskAfterRun(
      makeTask("running"),
      completedRunWithReport(),
      "cancel-task",
    );
    expect(settled.status).toBe("done");
  });

  it("completed Run 但证据不合格 → 原样抛 DoneEvidenceError，不自动 done", () => {
    const noEvidence = makeRun({ endedAt: 2_000, endReason: "completed" });
    expect(() => settleTaskAfterRun(makeTask("running"), noEvidence, "cancel-task")).toThrow(
      DoneEvidenceError,
    );
  });

  it("failed / crashed / interrupted Run → 任务 failed（可重试）", () => {
    for (const endReason of ["failed", "crashed", "interrupted"] as const) {
      const run = makeRun({ endedAt: 2_000, endReason });
      expect(settleTaskAfterRun(makeTask("running"), run, "cancel-task").status).toBe("failed");
    }
  });

  it("cancelled Run 由调用方定：cancel-task → cancelled，fail-task → failed（保留重试）", () => {
    const run = makeRun({ endedAt: 2_000, endReason: "cancelled" });
    expect(settleTaskAfterRun(makeTask("running"), run, "cancel-task").status).toBe("cancelled");
    expect(settleTaskAfterRun(makeTask("running"), run, "fail-task").status).toBe("failed");
  });

  it("联动前置：Run 必须已结束且属于该任务", () => {
    const inFlight = makeRun();
    expect(
      grab(
        () => settleTaskAfterRun(makeTask("running"), inFlight, "cancel-task"),
        RunLifecycleError,
      ).reason,
    ).toBe("run-not-ended");
    const foreign = completedRunWithReport({ taskId: OTHER_TASK_ID });
    expect(
      grab(() => settleTaskAfterRun(makeTask("running"), foreign, "cancel-task"), RunLifecycleError)
        .reason,
    ).toBe("run-task-mismatch");
  });
});
