/**
 * T7.1 交接包单测（设计文档 §10.4）：8 字段组装（记忆筛选、lesson 取样、未决问题派生、
 * expectation 四态）+ 文本渲染（八节齐全、空字段照样成节、确定性）+ 红线（取材源边界）。
 */

import type {
  Handoff,
  MemoryEntry,
  MemoryEntryId,
  Plan,
  PlanVersion,
  Task,
  TaskId,
} from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  buildHandoff,
  DEFAULT_RECENT_LESSONS,
  HANDOFF_HEADING,
  renderHandoff,
} from "../src/index.js";

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    version: 3 as PlanVersion,
    status: "approved",
    goal: "把导入流程做成可续传的",
    scope: ["src/ingest/"],
    nonGoals: ["不改检索层"],
    constraints: ["不引新依赖"],
    decisions: ["按内容哈希做增量"],
    tasks: [],
    acceptance: ["重复导入全跳过"],
    ...overrides,
  } as unknown as Plan;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1" as TaskId,
    planVersion: 3 as PlanVersion,
    goal: "实现增量跳过",
    writeScope: ["src/ingest/"],
    forbidden: [],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["有测试"],
    status: "pending",
    ...overrides,
  } as unknown as Task;
}

function memory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem-1" as MemoryEntryId,
    category: "decision",
    title: "用 RRF 融合",
    body: "两路召回没有可比量纲，只用名次。",
    status: "active",
    source: { kind: "user_manual" },
    confidence: "high",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  } as unknown as MemoryEntry;
}

describe("buildHandoff —— 8 字段组装", () => {
  it("projectGoal 缺省时取计划目标", () => {
    expect(buildHandoff({ plan: plan() }).projectGoal).toBe("把导入流程做成可续传的");
  });

  it("显式 projectGoal 优先于计划目标", () => {
    expect(buildHandoff({ projectGoal: "另一段话", plan: plan() }).projectGoal).toBe("另一段话");
  });

  it("无计划也能生成（plan 缺省，其余字段照常）", () => {
    const handoff = buildHandoff({ tasks: [task()] });
    expect(handoff.plan).toBeUndefined();
    expect(handoff.projectGoal).toBe("");
    expect(handoff.progress).toHaveLength(1);
  });

  it("progress 逐条带状态", () => {
    const handoff = buildHandoff({
      tasks: [task(), task({ id: "task-2" as TaskId, status: "accepted" })],
    });
    expect(handoff.progress).toEqual([
      { taskId: "task-1", goal: "实现增量跳过", status: "pending" },
      { taskId: "task-2", goal: "实现增量跳过", status: "accepted" },
    ]);
  });

  it("只收 active 记忆：candidate 与 archived 一律排除", () => {
    const handoff = buildHandoff({
      memory: [
        memory(),
        memory({ id: "mem-2" as MemoryEntryId, status: "candidate" }),
        memory({ id: "mem-3" as MemoryEntryId, status: "archived" }),
      ],
    });
    expect(handoff.decisions.map((e) => e.id)).toEqual(["mem-1"]);
  });

  it("按类别分流 decision / rule / lesson，state 不进交接包", () => {
    const handoff = buildHandoff({
      memory: [
        memory({ id: "d" as MemoryEntryId, category: "decision" }),
        memory({ id: "r" as MemoryEntryId, category: "rule" }),
        memory({ id: "l" as MemoryEntryId, category: "lesson" }),
        memory({ id: "s" as MemoryEntryId, category: "state" }),
      ],
    });
    expect(handoff.decisions.map((e) => e.id)).toEqual(["d"]);
    expect(handoff.rules.map((e) => e.id)).toEqual(["r"]);
    expect(handoff.recentLessons.map((e) => e.id)).toEqual(["l"]);
  });

  it("recentLessons 按 updatedAt 降序取前 N 条（缺省 DEFAULT_RECENT_LESSONS）", () => {
    const lessons = Array.from({ length: DEFAULT_RECENT_LESSONS + 3 }, (_v, i) =>
      memory({ id: `l${i}` as MemoryEntryId, category: "lesson", updatedAt: i }),
    );
    const handoff = buildHandoff({ memory: lessons });
    expect(handoff.recentLessons).toHaveLength(DEFAULT_RECENT_LESSONS);
    expect(handoff.recentLessons[0]?.updatedAt).toBe(DEFAULT_RECENT_LESSONS + 2);
  });

  it("decision / rule 不设取样上限（全量交接，与 lesson 的取舍不同）", () => {
    const rules = Array.from({ length: DEFAULT_RECENT_LESSONS + 4 }, (_v, i) =>
      memory({ id: `r${i}` as MemoryEntryId, category: "rule" }),
    );
    expect(buildHandoff({ memory: rules }).rules).toHaveLength(DEFAULT_RECENT_LESSONS + 4);
  });

  it("openIssues 从 blocked / failed 任务派生，done / cancelled 不算未决", () => {
    const handoff = buildHandoff({
      tasks: [
        task({ id: "t-block" as TaskId, status: "blocked" }),
        task({ id: "t-fail" as TaskId, status: "failed" }),
        task({ id: "t-done" as TaskId, status: "done" }),
        task({ id: "t-cancel" as TaskId, status: "cancelled" }),
      ],
    });
    expect(handoff.openIssues).toHaveLength(2);
    expect(handoff.openIssues[0]).toContain("t-block");
    expect(handoff.openIssues[1]).toContain("t-fail");
  });

  it("extraOpenIssues 接在派生项之后，空白项被剔除", () => {
    const handoff = buildHandoff({
      tasks: [task({ status: "blocked" })],
      extraOpenIssues: ["等用户确认接口形状", "   "],
    });
    expect(handoff.openIssues).toHaveLength(2);
    expect(handoff.openIssues[1]).toBe("等用户确认接口形状");
  });

  it.each([
    ["有 pending 任务 → 指名第一条", [task({ id: "t-a" as TaskId })], "t-a"],
    ["有 running 任务 → 说明是接手执行中的", [task({ status: "running" })], "接手执行中的"],
    ["只剩阻塞 → 先解阻塞", [task({ status: "blocked" })], "阻塞"],
    ["任务均为终态 → 交回用户决定", [task({ status: "accepted" })], "终态"],
  ])("expectation 派生：%s", (_label, tasks, expected) => {
    expect(buildHandoff({ tasks, plan: plan() }).expectation).toContain(expected);
  });

  it("expectation 派生：无任务且无计划 → 请先讨论目标出计划", () => {
    expect(buildHandoff({}).expectation).toContain("尚无计划");
  });

  it("expectation 派生：有计划但没拆任务 → 请先确认再拆任务", () => {
    expect(buildHandoff({ plan: plan() }).expectation).toContain("尚未拆出任务");
  });

  it("显式 expectation 覆盖派生结果；纯空白视为未给", () => {
    expect(buildHandoff({ expectation: "先跑一遍测试" }).expectation).toBe("先跑一遍测试");
    expect(buildHandoff({ expectation: "   " }).expectation).toContain("尚无计划");
  });
});

describe("renderHandoff —— 文本渲染", () => {
  function fullHandoff(): Handoff {
    return buildHandoff({
      plan: plan(),
      tasks: [task(), task({ id: "task-2" as TaskId, status: "blocked" })],
      memory: [
        memory({ id: "d" as MemoryEntryId, category: "decision", title: "决定甲" }),
        memory({ id: "r" as MemoryEntryId, category: "rule", title: "规则乙" }),
        memory({ id: "l" as MemoryEntryId, category: "lesson", title: "教训丙" }),
      ],
    });
  }

  it("八个字段各成一节，标题在首行", () => {
    const text = renderHandoff(fullHandoff());
    expect(text.startsWith(HANDOFF_HEADING)).toBe(true);
    for (const heading of [
      "## 项目目标",
      "## 计划 v3",
      "## 任务进度",
      "## 已确认的决定（decision）",
      "## 必须遵守的规则（rule）",
      "## 最近的经验教训（lesson）",
      "## 阻塞与未决问题",
      "## 期望你接下来做什么",
    ]) {
      expect(text).toContain(heading);
    }
  });

  it("前言明说这是交接而非会话恢复，并划出三条边界", () => {
    const text = renderHandoff(fullHandoff());
    expect(text).toContain("接手");
    expect(text).toContain("会话记录");
    expect(text).toContain("密钥");
  });

  it("空字段照样成节并写明（无），不静默消失", () => {
    const text = renderHandoff(buildHandoff({}));
    expect(text).toContain("## 计划\n\n（尚无计划。）");
    expect(text).toContain("（尚未拆出任务）");
    expect(text).toContain("## 已确认的决定（decision）\n\n（无）");
    expect(text).toContain("## 阻塞与未决问题\n\n（无）");
    expect(text).toContain("（工作台侧未登记项目目标。）");
  });

  it("任务进度带领域状态原值", () => {
    expect(renderHandoff(fullHandoff())).toContain("- [blocked] task-2：实现增量跳过");
  });

  it("记忆正文完整渲染、不截断（decision/rule 是约束，截断即改变含义）", () => {
    const body = "第一句。".repeat(200);
    const text = renderHandoff(
      buildHandoff({ memory: [memory({ category: "rule", title: "长规则", body })] }),
    );
    expect(text).toContain(body);
  });

  it("计划节不重复渲染任务清单（progress 已带状态列出）", () => {
    const text = renderHandoff(
      buildHandoff({
        plan: plan({ tasks: [task({ goal: "计划内合同不该在计划节露面" })] }),
        tasks: [],
      }),
    );
    expect(text).not.toContain("计划内合同不该在计划节露面");
  });

  it("确定性：同一交接包两次渲染逐字节相同", () => {
    const handoff = fullHandoff();
    expect(renderHandoff(handoff)).toBe(renderHandoff(handoff));
  });

  it("红线：交接包里没有执行记录面——与 assembleRebuildContext 的取材边界不同", () => {
    // §10.4 红线的落法是取材源里物理不含原始日志：HandoffInput 只有 plan / tasks / memory
    // 三样，不接收 Run（raw.log 与命令流的宿主）。对比 T4.3 的上下文重建——那是同 Agent
    // 续接自己的历史，故渲染最近 Run 报告；交接给别人则不给。这条钉住两者不被"顺手统一"。
    const text = renderHandoff(buildHandoff({ plan: plan(), tasks: [task()], memory: [memory()] }));
    expect(text).not.toContain("执行记录");
    expect(text).not.toContain("raw.log");
  });
});
