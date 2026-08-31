/**
 * T7.2 任务卡片审查态派生单测（纯逻辑，无 React）。
 */

import type { Run, Task } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { canReviewTask, deriveTaskReview } from "../src/renderer/src/pages/tasks/task-review";

function task(overrides: Partial<Record<keyof Task, unknown>> = {}): Task {
  return { id: "task-1", status: "done", ...overrides } as unknown as Task;
}

/** overrides 用宽松形态：品牌 ID 在测试里逐个 as 会淹没断言本身。 */
function run(overrides: Partial<Record<keyof Run, unknown>> = {}): Run {
  return {
    id: "run-1",
    taskId: "task-1",
    attempt: 1,
    endReason: "completed",
    fileChanges: [],
    commands: [],
    rawLogPath: "raw.log",
    ...overrides,
  } as unknown as Run;
}

describe("deriveTaskReview", () => {
  it("没有 Run → 空态", () => {
    expect(deriveTaskReview(task(), [])).toEqual({});
  });

  it("只看本任务的 Run（别的任务的尝试不算数）", () => {
    const state = deriveTaskReview(task(), [run({ id: "other", taskId: "task-2", attempt: 9 })]);
    expect(state.latestRun).toBeUndefined();
  });

  it("取 attempt 最大者，而非数组末位（runs:list 的顺序与尝试先后无关）", () => {
    const state = deriveTaskReview(task(), [
      run({ id: "r3", attempt: 3 }),
      run({ id: "r1", attempt: 1 }),
      run({ id: "r2", attempt: 2 }),
    ]);
    expect(state.latestRun?.id).toBe("r3");
  });

  it("最近一次的结论即任务的结论；更早那次审过也不算", () => {
    const state = deriveTaskReview(task(), [
      run({
        id: "r1",
        attempt: 1,
        review: {
          reviewedAt: 1,
          profileId: "p",
          verdict: "pass",
          summary: "s",
          findings: [],
          commands: [],
        },
      }),
      run({ id: "r2", attempt: 2 }),
    ]);
    expect(state.latestRun?.id).toBe("r2");
    expect(state.verdict).toBeUndefined();
  });

  it("最近一次审过 → 带出结论", () => {
    const state = deriveTaskReview(task(), [
      run({
        review: {
          reviewedAt: 1,
          profileId: "p",
          verdict: "fail",
          summary: "s",
          findings: ["x"],
          commands: [],
        },
      }),
    ]);
    expect(state.verdict).toBe("fail");
  });
});

describe("canReviewTask", () => {
  it("done 且有执行记录 → 可审查", () => {
    expect(canReviewTask(task(), deriveTaskReview(task(), [run()]))).toBe(true);
  });

  it("done 但一条 Run 都没有 → 不可（没有产出可对照）", () => {
    expect(canReviewTask(task(), {})).toBe(false);
  });

  it.each(["pending", "running", "blocked", "failed", "accepted", "cancelled"] as const)(
    "%s 态不可审查（accepted 已由用户拍板，要重审得先返工）",
    (status) => {
      const t = task({ status });
      expect(canReviewTask(t, deriveTaskReview(t, [run()]))).toBe(false);
    },
  );

  it("审过一次后仍可再审（换了 Reviewer、或用户不信第一次的结论）", () => {
    const runs = [
      run({
        review: {
          reviewedAt: 1,
          profileId: "p",
          verdict: "pass",
          summary: "s",
          findings: [],
          commands: [],
        },
      }),
    ];
    expect(canReviewTask(task(), deriveTaskReview(task(), runs))).toBe(true);
  });
});
