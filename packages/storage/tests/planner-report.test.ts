/**
 * T9.10 待汇报队列落盘单测（planner-report.json）：mkdtemp 临时目录真实读写。
 *
 * 覆盖：空状态读回、入队（升序落位 / 同 taskId 替换去重 / 超上限丢最旧）、
 * 消费（清队列 + 换基准一次写盘）、损坏归一（JSON 语法损坏隔离 / 结构不符
 * 归空 + onInvalid 留痕）、layout 落点。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PlannerBoardBaseline,
  SettlementReportEntry,
  TaskId,
  TaskSettledStatus,
} from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumePlannerReport,
  enqueueSettlementReport,
  MAX_QUEUE_ENTRIES,
  PLANNER_REPORT_FILE_VERSION,
  type ProjectLayout,
  readPlannerReport,
  resolveProjectLayout,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/index.js";

let tempRoot: string;
let layout: ProjectLayout;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-planner-report-"));
  layout = resolveProjectLayout(tempRoot);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function entry(overrides: Partial<SettlementReportEntry> = {}): SettlementReportEntry {
  return {
    taskId: "task-1" as TaskId,
    status: "done" as TaskSettledStatus,
    summary: "任务 task-1「x」已完成",
    settledAt: 1000,
    ...overrides,
  };
}

describe("planner-report 落盘队列", () => {
  it("layout 落点：planner-report.json 在 .workbench 根下", () => {
    expect(layout.plannerReportFile).toBe(join(tempRoot, ".workbench", "planner-report.json"));
  });

  it("文件不存在读回空状态（无基准、空队列）", async () => {
    const state = await readPlannerReport(layout);
    expect(state.baseline).toBeUndefined();
    expect(state.queue).toEqual([]);
  });

  it("入队后读回；文件形状带版本号；按 settledAt 升序", async () => {
    await enqueueSettlementReport(layout, entry({ taskId: "t-b" as TaskId, settledAt: 2000 }));
    await enqueueSettlementReport(layout, entry({ taskId: "t-a" as TaskId, settledAt: 1000 }));
    const state = await readPlannerReport(layout);
    expect(state.queue.map((queued) => queued.taskId)).toEqual(["t-a", "t-b"]);

    const raw = JSON.parse(await readFile(layout.plannerReportFile, "utf8")) as {
      version: number;
      queue: unknown[];
    };
    expect(raw.version).toBe(PLANNER_REPORT_FILE_VERSION);
    expect(raw.queue).toHaveLength(2);
  });

  it("同 taskId 再次入队替换旧条目（同一任务多次落定不堆双份摘要）", async () => {
    await enqueueSettlementReport(
      layout,
      entry({ status: "failed", summary: "第一次失败", settledAt: 1000 }),
    );
    await enqueueSettlementReport(
      layout,
      entry({ status: "done", summary: "重试后完成", settledAt: 2000 }),
    );
    const state = await readPlannerReport(layout);
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]).toMatchObject({ status: "done", summary: "重试后完成" });
  });

  it("队列有硬上限：超 MAX_QUEUE_ENTRIES 丢最旧", async () => {
    for (let i = 0; i < MAX_QUEUE_ENTRIES + 5; i += 1) {
      await enqueueSettlementReport(
        layout,
        entry({ taskId: `t-${String(i).padStart(3, "0")}` as TaskId, settledAt: i }),
      );
    }
    const state = await readPlannerReport(layout);
    expect(state.queue).toHaveLength(MAX_QUEUE_ENTRIES);
    // 丢的是最旧的 5 条
    expect(state.queue[0]?.taskId).toBe("t-005");
    expect(state.queue.at(-1)?.taskId).toBe(`t-${String(MAX_QUEUE_ENTRIES + 4).padStart(3, "0")}`);
  });

  it("消费：清队列 + 换基准一次写盘；后续入队不动基准", async () => {
    await enqueueSettlementReport(layout, entry());
    const baseline: PlannerBoardBaseline = {
      plannerTurnAt: 5000,
      taskStatuses: { "task-1": "done", "task-2": "pending" },
    };
    await consumePlannerReport(layout, baseline);

    const consumed = await readPlannerReport(layout);
    expect(consumed.queue).toEqual([]);
    expect(consumed.baseline).toEqual(baseline);

    // 消费后的新落定重新积累，基准保持
    await enqueueSettlementReport(layout, entry({ taskId: "task-3" as TaskId, settledAt: 6000 }));
    const after = await readPlannerReport(layout);
    expect(after.queue).toHaveLength(1);
    expect(after.baseline).toEqual(baseline);
  });

  it("JSON 语法损坏：fs 层隔离后读回空状态（队列重新积累，不抛错）", async () => {
    await writeTextAtomic(layout.plannerReportFile, "{ 坏掉的 json");
    const state = await readPlannerReport(layout);
    expect(state.queue).toEqual([]);
    // 隔离后原路径已让位，下次写入重建
    await enqueueSettlementReport(layout, entry());
    expect((await readPlannerReport(layout)).queue).toHaveLength(1);
  });

  it("结构不符（版本不对 / queue 非法条目 / 基准非法）归一为空状态并经 onInvalid 留痕", async () => {
    await writeJsonAtomic(layout.plannerReportFile, { version: 99, queue: [] });
    const reasons: string[] = [];
    const badVersion = await readPlannerReport(layout, (reason) => reasons.push(reason));
    expect(badVersion.queue).toEqual([]);
    expect(reasons).toHaveLength(1);

    await writeJsonAtomic(layout.plannerReportFile, {
      version: PLANNER_REPORT_FILE_VERSION,
      queue: [{ taskId: "t", status: "running", summary: "x", settledAt: 1 }],
    });
    const badEntry = await readPlannerReport(layout, (reason) => reasons.push(reason));
    expect(badEntry.queue).toEqual([]);
    expect(reasons).toHaveLength(2);

    // 基准非法：基准被弃、队列合法则保留（基准与队列独立校验）
    await writeJsonAtomic(layout.plannerReportFile, {
      version: PLANNER_REPORT_FILE_VERSION,
      baseline: { plannerTurnAt: "非数字", taskStatuses: {} },
      queue: [entry()],
    });
    const badBaseline = await readPlannerReport(layout);
    expect(badBaseline.baseline).toBeUndefined();
    expect(badBaseline.queue).toHaveLength(1);
  });
});
