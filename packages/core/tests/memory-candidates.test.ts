/**
 * T4.4 记忆候选派生单测：从已验收任务的最近 Run 报告沉淀 lesson 候选。
 * 覆盖：有报告 → 一条 candidate（字段齐全 + 来源 task）、无报告 / 无匹配 Run → 空、
 * 多 Run 取最近一次有报告者、正文按上限截断。
 */

import type { EpochMillis, MemoryEntryId, Run, RunId, Task, TaskId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { deriveAcceptanceCandidates } from "../src/index.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1" as TaskId,
    planVersion: 1,
    goal: "实现 sum() 工具函数",
    writeScope: ["src/util.ts"],
    forbidden: [],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["有测试"],
    status: "accepted",
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
    report: "新增 sum() 并补测试，pnpm test 通过",
    rawLogPath: "raw.log",
    ...overrides,
  } as unknown as Run;
}

const NOW = 5000 as EpochMillis;
let counter = 0;
function newId(): MemoryEntryId {
  counter += 1;
  return `mem-${counter}` as MemoryEntryId;
}

describe("deriveAcceptanceCandidates", () => {
  it("有 Run 报告 → 一条 lesson 候选，字段齐全、来源 task、置信度 low", () => {
    const out = deriveAcceptanceCandidates({ task: task(), runs: [run()], now: NOW, newId });
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c).toMatchObject({
      category: "lesson",
      title: "实现 sum() 工具函数",
      status: "candidate",
      confidence: "low",
      source: { kind: "task", taskId: "task-1" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(c?.body).toContain("pnpm test 通过");
  });

  it("无匹配 Run → 空数组（N=0，不造空候选）", () => {
    const out = deriveAcceptanceCandidates({
      task: task(),
      runs: [run({ taskId: "other" as TaskId })],
      now: NOW,
      newId,
    });
    expect(out).toEqual([]);
  });

  it("Run 报告为空 → 空数组", () => {
    const out = deriveAcceptanceCandidates({
      task: task(),
      runs: [run({ report: "   " })],
      now: NOW,
      newId,
    });
    expect(out).toEqual([]);
  });

  it("多 Run → 取最近一次有报告者（attempt 较大）", () => {
    const runs = [
      run({ id: "r1" as RunId, attempt: 1, report: "第一次尝试" }),
      run({ id: "r2" as RunId, attempt: 2, report: "第二次通过" }),
    ];
    const out = deriveAcceptanceCandidates({ task: task(), runs, now: NOW, newId });
    expect(out[0]?.body).toContain("第二次通过");
  });

  it("长报告按上限截断（尾附省略号）", () => {
    const out = deriveAcceptanceCandidates({
      task: task(),
      runs: [run({ report: "x".repeat(50) })],
      now: NOW,
      newId,
      maxBodyChars: 10,
    });
    expect(out[0]?.body).toBe(`${"x".repeat(10)}…`);
  });
});
