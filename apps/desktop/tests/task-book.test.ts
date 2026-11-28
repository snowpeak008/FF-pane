/**
 * T11.24：自动记账。开窗派活、汇报到账时由平台改账本；记不了账不影响开窗和汇报本身。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerTask } from "../src/main/workbench/task-ledger";
import { readOpenLedger, updateLedger } from "../src/main/workbench/task-ledger-store";
import {
  bookAssignment,
  bookReport,
  executeTasksTool,
  summarizeForManager,
  type TaskToolCaller,
  type TaskToolDeps,
} from "../src/main/workbench/task-tools";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-book-"));
  dirs.push(dir);
  return dir;
}

const clock = 5000;
const deps: TaskToolDeps = {
  now: () => clock,
  isManagerGranted: (id) => id === "m1",
  describe: async (id) => ({ id, title: `窗口 ${id}`, role: "worker" }),
};

function who(id: string, role: string, projectRoot: string): TaskToolCaller {
  return { id, title: `窗口 ${id}`, role, projectRoot };
}

async function seed(root: string, task: Partial<LedgerTask>): Promise<string> {
  const id = task.id ?? "t-seed";
  const full: LedgerTask = {
    id,
    title: task.title ?? "任务",
    detail: "",
    acceptance: "验收",
    status: task.status ?? "todo",
    createdAt: 1,
    updatedAt: 1,
    createdBy: { windowId: "m1", title: "管理者", role: "manager" },
    events: [],
    ...task,
  };
  await updateLedger(root, (open) => ({
    tasks: [...open.filter((item) => item.id !== id), full],
  }));
  return id;
}

async function find(root: string, id: string): Promise<LedgerTask> {
  const { tasks } = await readOpenLedger(root);
  const found = tasks.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`missing ${id}`);
  }
  return found;
}

describe("开窗派活自动记账", () => {
  // 记账里 updateLedger 的第三个参数必须是无参函数；传 input.now 本身会在运行期抛
  // 「input.now is not a function」，被吞成「记账失败」——所以每条都断言 ok 和落盘结果。
  it("把任务标成执行中并记下负责窗口和说明", async () => {
    const root = project();
    const id = await seed(root, {});
    const result = await bookAssignment({
      projectRoot: root,
      taskId: id,
      assignee: { windowId: "w9", title: "执行甲", role: "worker" },
      briefPath: ".ffpane/briefs/甲.md",
      byTitle: "管理者",
      now: () => 7000,
    });
    expect(result.ok).toBe(true);
    const task = await find(root, id);
    expect(task.status).toBe("doing");
    expect(task.assignee?.windowId).toBe("w9");
    expect(task.brief).toBe(".ffpane/briefs/甲.md");
    expect(task.updatedAt).toBe(7000);
  });

  it("账本里没有这条：返回说明，不抛错", async () => {
    const result = await bookAssignment({
      projectRoot: project(),
      taskId: "t-none",
      assignee: { windowId: "w1", title: "甲", role: "worker" },
      byTitle: "管理者",
      now: () => 1,
    });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("没有任务");
  });
});

describe("汇报自动记账", () => {
  it("progress 刷执行情况，done 标待检查，blocked 标卡住，failed 标失败", async () => {
    const root = project();
    const reporter = { windowId: "w1", title: "执行甲", role: "worker" };
    const booking = (taskId: string, status: "progress" | "blocked" | "done" | "failed") =>
      bookReport({
        projectRoot: root,
        taskId,
        status,
        reporter,
        summary: `汇报 ${status}`,
        now: () => 9,
      });

    const a = await seed(root, { id: "ta" });
    await bookAssignment({
      projectRoot: root,
      taskId: a,
      assignee: reporter,
      byTitle: "管理者",
      now: () => 2,
    });
    await booking(a, "progress");
    expect((await find(root, a)).progress).toBe("汇报 progress");

    const b = await seed(root, { id: "tb" });
    await bookAssignment({
      projectRoot: root,
      taskId: b,
      assignee: reporter,
      byTitle: "管理者",
      now: () => 2,
    });
    await booking(b, "done");
    expect((await find(root, b)).status).toBe("submitted");

    const c = await seed(root, { id: "tc" });
    await bookAssignment({
      projectRoot: root,
      taskId: c,
      assignee: reporter,
      byTitle: "管理者",
      now: () => 2,
    });
    await booking(c, "blocked");
    expect((await find(root, c)).status).toBe("blocked");

    const d = await seed(root, { id: "td" });
    await bookAssignment({
      projectRoot: root,
      taskId: d,
      assignee: reporter,
      byTitle: "管理者",
      now: () => 2,
    });
    await booking(d, "failed");
    expect((await find(root, d)).status).toBe("failed");
  });

  it("执行者不能靠汇报把任务标成完成", async () => {
    const root = project();
    const reporter = { windowId: "w1", title: "执行甲", role: "worker" };
    const id = await seed(root, { status: "doing" });
    await bookReport({
      projectRoot: root,
      taskId: id,
      status: "done",
      reporter,
      summary: "做完了",
      now: () => 3,
    });
    const task = await find(root, id);
    expect(task.status).toBe("submitted");
    expect(task.status).not.toBe("done");
  });

  it("反复报进度不往时间线堆同一种事件", async () => {
    const root = project();
    const reporter = { windowId: "w1", title: "执行甲", role: "worker" };
    const id = await seed(root, { status: "doing" });
    await bookReport({
      projectRoot: root,
      taskId: id,
      status: "progress",
      reporter,
      summary: "一",
      now: () => 3,
    });
    await bookReport({
      projectRoot: root,
      taskId: id,
      status: "progress",
      reporter,
      summary: "二",
      now: () => 4,
    });
    const task = await find(root, id);
    expect(task.progress).toBe("二");
    expect(task.events).toHaveLength(0);
  });

  it("记不了账不影响汇报：返回说明而不是抛错", async () => {
    const result = await bookReport({
      projectRoot: project(),
      taskId: "t-none",
      status: "done",
      reporter: { windowId: "w1", title: "甲", role: "worker" },
      summary: "做完了",
      now: () => 1,
    });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("没有任务");
  });
});

describe("管理者每轮摘要", () => {
  it("没有任务时不返回，有任务时报未完成条数和要处理的条数", async () => {
    const root = project();
    expect(await summarizeForManager(root)).toBeUndefined();

    const manager = who("m1", "manager", root);
    await executeTasksTool(manager, { action: "add", title: "要活的活", acceptance: "甲" }, deps);
    await seed(root, { id: "tf", status: "failed", title: "失败的活" });

    const line = await summarizeForManager(root);
    expect(line).toContain("未完成 2 条");
    expect(line).toContain("要你处理");
    expect(line).toContain("tf");
  });
});
