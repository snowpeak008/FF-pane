/**
 * T4.3 会话恢复单测：恢复方式判定（native / context_rebuild 的判据矩阵）+
 * 上下文重建文本组装（各维度有/无事实、Run 取样与报告截断、全空兜底）。
 */

import type { Plan, PlanVersion, Run, RunId, Task, TaskId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  assembleRebuildContext,
  DEFAULT_RECENT_RUNS,
  decideResumeKind,
  REBUILD_CONTEXT_HEADING,
} from "../src/index.js";

describe("decideResumeKind", () => {
  it("三项判据全真 → native", () => {
    expect(
      decideResumeKind({
        hasNativeBinding: true,
        bindingCwdMatches: true,
        supportsNativeResume: true,
      }),
    ).toBe("native");
  });

  it.each([
    [
      "无原生绑定",
      { hasNativeBinding: false, bindingCwdMatches: true, supportsNativeResume: true },
    ],
    [
      "cwd 不匹配",
      { hasNativeBinding: true, bindingCwdMatches: false, supportsNativeResume: true },
    ],
    [
      "Runtime 不支持",
      { hasNativeBinding: true, bindingCwdMatches: true, supportsNativeResume: false },
    ],
  ])("任一判据为假（%s）→ context_rebuild", (_label, input) => {
    expect(decideResumeKind(input)).toBe("context_rebuild");
  });
});

function plan(): Plan {
  return {
    version: 2 as PlanVersion,
    status: "approved",
    goal: "加一个工具函数并通过测试",
    scope: ["src/util.ts"],
    nonGoals: [],
    constraints: ["不改公共 API"],
    decisions: [],
    tasks: [],
    acceptance: ["pnpm test 通过"],
  } as unknown as Plan;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1" as TaskId,
    planVersion: 2 as PlanVersion,
    goal: "实现 sum()",
    writeScope: ["src/util.ts"],
    forbidden: [],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["有测试"],
    status: "done",
    ...overrides,
  } as unknown as Task;
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1" as RunId,
    taskId: "task-1" as TaskId,
    attempt: 1,
    profileId: "prof-1",
    startedAt: 1000,
    endedAt: 2000,
    endReason: "completed",
    fileChanges: [],
    commands: [],
    report: "实现完成，测试通过",
    rawLogPath: "raw.log",
    ...overrides,
  } as unknown as Run;
}

describe("assembleRebuildContext", () => {
  it("全维度：标题 + 计划 + 任务 + 状态 + 最近 Run 报告", () => {
    const text = assembleRebuildContext({
      plan: plan(),
      tasks: [task()],
      stateSnapshot: "正在实现工具函数",
      recentRuns: [run()],
    });
    expect(text).toContain(REBUILD_CONTEXT_HEADING);
    expect(text).toContain("当前计划 v2（approved）");
    expect(text).toContain("task-1：实现 sum()（done）");
    expect(text).toContain("正在实现工具函数");
    expect(text).toContain("实现完成，测试通过");
  });

  it("最近 Run 只取末尾 maxRuns 条（末尾即最近）", () => {
    const runs = Array.from({ length: 5 }, (_v, i) =>
      run({ id: `run-${i}` as RunId, report: `报告${i}` }),
    );
    const text = assembleRebuildContext({ recentRuns: runs });
    expect(text).toContain(`最近执行记录（${DEFAULT_RECENT_RUNS}/5）`);
    expect(text).toContain("报告4");
    expect(text).not.toContain("报告1");
  });

  it("长报告按 maxReportChars 截断", () => {
    const text = assembleRebuildContext({
      recentRuns: [run({ report: "x".repeat(50) })],
      maxReportChars: 10,
    });
    expect(text).toContain("（已截断）");
    expect(text).not.toContain("x".repeat(20));
  });

  it("全空：仅标题 + 无事实说明（仍是有效上下文，避免 Agent 臆造进度）", () => {
    const text = assembleRebuildContext({});
    expect(text).toContain(REBUILD_CONTEXT_HEADING);
    expect(text).toContain("暂无可重建");
  });
});
