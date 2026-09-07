/**
 * T9.10 Planner 跟进回路纯逻辑单测：
 * 1. composeSettlementSummary —— 落定三态各自的一句话摘要款式（done 带验证结论、
 *    failed 带尝试次数与结束原因、blocked 一句等待语），目标 / 报告超长截断；
 * 2. computeBoardDelta —— 新增 / 状态变化 / 移除三类 diff，未变任务不产行；
 * 3. assembleBoardDelta —— 注入文本含队列与看板增量小节、条数与字符上限截断、
 *    首次注入（无基准）给计数概览、无战况返回 undefined（不占提示词）。
 */

import type {
  PlannerBoardBaseline,
  PlanVersion,
  ProfileId,
  Run,
  RunId,
  SettlementReportEntry,
  Task,
  TaskId,
  TaskStatus,
} from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  assembleBoardDelta,
  boardSnapshotOf,
  composeSettlementSummary,
  computeBoardDelta,
  DEFAULT_BOARD_DELTA_LIMIT,
  DEFAULT_REPORT_QUEUE_LIMIT,
  REPORT_CONTEXT_HEADING,
  REPORT_DELTA_HEADING,
  REPORT_QUEUE_HEADING,
  SUMMARY_GOAL_CHARS,
} from "../src/index.js";

function task(overrides: Partial<Record<keyof Task, unknown>> = {}): Task {
  return {
    id: "task-1" as TaskId,
    planVersion: 1 as PlanVersion,
    goal: "实现登录页",
    writeScope: ["src/**"],
    forbidden: [],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["单测全绿"],
    status: "done",
    ...overrides,
  } as Task;
}

function run(overrides: Partial<Record<keyof Run, unknown>> = {}): Run {
  return {
    id: "run-1" as RunId,
    taskId: "task-1" as TaskId,
    attempt: 2,
    profileId: "prof-1" as ProfileId,
    startedAt: 1000,
    endedAt: 2000,
    endReason: "completed",
    fileChanges: [],
    commands: [],
    rawLogPath: "raw.log",
    ...overrides,
  } as Run;
}

function queueEntry(overrides: Partial<SettlementReportEntry> = {}): SettlementReportEntry {
  return {
    taskId: "task-1" as TaskId,
    status: "done",
    summary: "任务 task-1「实现登录页」已完成",
    settledAt: 1000,
    ...overrides,
  };
}

describe("composeSettlementSummary（落定三态的一句话摘要）", () => {
  it("done：带任务 ID、目标、尝试次数、验证结论与报告首行", () => {
    const summary = composeSettlementSummary({
      task: task(),
      status: "done",
      run: run({
        verifyResult: { command: "pnpm test", exitCode: 0, output: "ok" },
        report: "改了 3 个文件\n细节……",
      }),
    });
    expect(summary).toContain("task-1");
    expect(summary).toContain("实现登录页");
    expect(summary).toContain("已完成");
    expect(summary).toContain("第 2 次尝试");
    expect(summary).toContain("验证通过");
    expect(summary).toContain("改了 3 个文件");
    expect(summary).not.toContain("细节");
  });

  it("done：无验证结果如实标「未跑验证」；验证退出码非 0 如实带出", () => {
    expect(composeSettlementSummary({ task: task(), status: "done", run: run() })).toContain(
      "未跑验证",
    );
    expect(
      composeSettlementSummary({
        task: task(),
        status: "done",
        run: run({ verifyResult: { command: "x", exitCode: 3, output: "" } }),
      }),
    ).toContain("验证退出码 3");
  });

  it("failed：带尝试次数与 Run 结束原因（crashed 对 Planner 是有用信息）", () => {
    const summary = composeSettlementSummary({
      task: task({ status: "failed" }),
      status: "failed",
      run: run({ endReason: "crashed", report: "进程异常退出" }),
    });
    expect(summary).toContain("执行失败");
    expect(summary).toContain("第 2 次尝试");
    expect(summary).toContain("原因 crashed");
    expect(summary).toContain("进程异常退出");
  });

  it("failed：无 Run（修正路径铸 Run 失败）给简版摘要，不抛错", () => {
    const summary = composeSettlementSummary({
      task: task({ status: "failed" }),
      status: "failed",
    });
    expect(summary).toContain("task-1");
    expect(summary).toContain("执行失败");
  });

  it("blocked：一句等待语，不掺 Run 细节", () => {
    const summary = composeSettlementSummary({
      task: task({ status: "blocked" }),
      status: "blocked",
      run: run(),
    });
    expect(summary).toContain("被阻塞");
    expect(summary).toContain("等待澄清或权限");
  });

  it("目标超长截断（SUMMARY_GOAL_CHARS）", () => {
    const longGoal = "目".repeat(SUMMARY_GOAL_CHARS + 40);
    const summary = composeSettlementSummary({
      task: task({ goal: longGoal }),
      status: "done",
      run: run(),
    });
    expect(summary).toContain(`${"目".repeat(SUMMARY_GOAL_CHARS)}…`);
    expect(summary).not.toContain("目".repeat(SUMMARY_GOAL_CHARS + 1));
  });
});

describe("computeBoardDelta（基准 diff）", () => {
  const baseline: PlannerBoardBaseline = {
    plannerTurnAt: 1000,
    taskStatuses: { "task-1": "running", "task-2": "pending", "task-3": "done" },
  };

  it("新增 / 状态变化 / 移除三类各产一行；未变任务不产行", () => {
    const tasks = [
      task({ id: "task-1" as TaskId, status: "failed" }), // 变化
      task({ id: "task-2" as TaskId, status: "pending" }), // 未变
      task({ id: "task-4" as TaskId, status: "pending" }), // 新增
      // task-3 消失（移除）
    ];
    const delta = computeBoardDelta(baseline, tasks);
    expect(delta).toEqual([
      {
        taskId: "task-1",
        kind: "status-changed",
        from: "running",
        to: "failed",
        goal: "实现登录页",
      },
      { taskId: "task-4", kind: "added", to: "pending", goal: "实现登录页" },
      { taskId: "task-3", kind: "removed", from: "done" },
    ]);
  });

  it("看板与基准完全一致时 diff 为空", () => {
    const tasks = (Object.entries(baseline.taskStatuses) as [string, TaskStatus][]).map(
      ([id, status]) => task({ id: id as TaskId, status }),
    );
    expect(computeBoardDelta(baseline, tasks)).toEqual([]);
  });

  it("boardSnapshotOf：从任务列表建 taskId → status 映射", () => {
    expect(
      boardSnapshotOf([
        task({ id: "a" as TaskId, status: "running" }),
        task({ id: "b" as TaskId, status: "done" }),
      ]),
    ).toEqual({ a: "running", b: "done" });
  });
});

describe("assembleBoardDelta（注入文本组装）", () => {
  const baseline: PlannerBoardBaseline = {
    plannerTurnAt: 1000,
    taskStatuses: { "task-1": "running" },
  };

  it("注入内容含待汇报队列与看板增量两个小节（合同验收）", () => {
    const text = assembleBoardDelta({
      queue: [queueEntry({ summary: "任务 task-1「实现登录页」执行失败（第 1 次尝试）" })],
      tasks: [task({ id: "task-1" as TaskId, status: "failed" })],
      baseline,
    });
    expect(text).toBeDefined();
    expect(text).toContain(REPORT_CONTEXT_HEADING);
    expect(text).toContain(REPORT_QUEUE_HEADING);
    expect(text).toContain("执行失败（第 1 次尝试）");
    expect(text).toContain(REPORT_DELTA_HEADING);
    expect(text).toContain("running → failed");
  });

  it("队列条数上限截断：只取最近 N 条并标注 N/总数", () => {
    const queue = Array.from({ length: DEFAULT_REPORT_QUEUE_LIMIT + 5 }, (_, i) =>
      queueEntry({
        taskId: `t-${String(i).padStart(2, "0")}` as TaskId,
        summary: `摘要-${String(i).padStart(2, "0")}`,
        settledAt: i,
      }),
    );
    const text = assembleBoardDelta({ queue, tasks: [], baseline });
    expect(text).toContain(
      `${REPORT_QUEUE_HEADING}（${DEFAULT_REPORT_QUEUE_LIMIT}/${DEFAULT_REPORT_QUEUE_LIMIT + 5}）`,
    );
    // 最旧的 5 条被截掉，最近的还在
    expect(text).not.toContain("摘要-00");
    expect(text).not.toContain("摘要-04");
    expect(text).toContain("摘要-05");
    expect(text).toContain(`摘要-${String(DEFAULT_REPORT_QUEUE_LIMIT + 4).padStart(2, "0")}`);
  });

  it("看板增量行数上限截断：只取前 N 行并标注 N/总数", () => {
    const tasks = Array.from({ length: DEFAULT_BOARD_DELTA_LIMIT + 3 }, (_, i) =>
      task({ id: `t-${String(i).padStart(2, "0")}` as TaskId, status: "pending" }),
    );
    const text = assembleBoardDelta({
      queue: [],
      tasks,
      baseline: { plannerTurnAt: 1, taskStatuses: {} },
    });
    expect(text).toContain(
      `${REPORT_DELTA_HEADING}（${DEFAULT_BOARD_DELTA_LIMIT}/${DEFAULT_BOARD_DELTA_LIMIT + 3}）`,
    );
    expect(text).toContain("t-00");
    expect(text).not.toContain(`t-${String(DEFAULT_BOARD_DELTA_LIMIT).padStart(2, "0")}（`);
  });

  it("单行字符上限截断（防手改落盘文件的超长行）", () => {
    const text = assembleBoardDelta({
      queue: [queueEntry({ summary: "长".repeat(500) })],
      tasks: [],
      baseline,
      maxLineChars: 50,
    });
    expect(text).toContain("（已截断）");
    expect(text).not.toContain("长".repeat(51));
  });

  it("首次注入（无基准）：不假装有增量，给当前看板计数概览", () => {
    const text = assembleBoardDelta({
      queue: [],
      tasks: [
        task({ id: "a" as TaskId, status: "pending" }),
        task({ id: "b" as TaskId, status: "running" }),
      ],
    });
    expect(text).toContain("首次注入");
    expect(text).toContain("共 2 个任务");
    expect(text).toContain("pending 1");
    expect(text).toContain("running 1");
  });

  it("无战况（队列空 + 看板无变化 / 首次注入且看板为空）返回 undefined，不占提示词", () => {
    expect(
      assembleBoardDelta({
        queue: [],
        tasks: [task({ id: "task-1" as TaskId, status: "running" })],
        baseline,
      }),
    ).toBeUndefined();
    expect(assembleBoardDelta({ queue: [], tasks: [] })).toBeUndefined();
  });
});
