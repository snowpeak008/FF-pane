/**
 * T11.24：ffpane_tasks 工具。权限、重合拒绝、拆子任务、派活、免检结束、取消。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeTasksTool,
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
  const dir = mkdtempSync(join(tmpdir(), "ffpane-tools-"));
  dirs.push(dir);
  return dir;
}

let clock = 1000;

const deps: TaskToolDeps = {
  now: () => clock,
  isManagerGranted: (id) => id === "m1",
  describe: async (id) => ({ id, title: `窗口 ${id}`, role: "worker" }),
};

function who(id: string, role: string, projectRoot: string): TaskToolCaller {
  return { id, title: `窗口 ${id}`, role, projectRoot };
}

async function run(caller: TaskToolCaller, args: Record<string, unknown>) {
  clock += 1;
  const result = await executeTasksTool(caller, args, deps);
  const error = result.isError === true;
  return {
    error,
    text: result.text,
    json: (error ? undefined : JSON.parse(result.text)) as Record<string, never> & {
      created?: string;
      count?: number;
      cancelled?: readonly string[];
    },
  };
}

const SAME = {
  action: "add",
  title: "查船跑沉船链原因",
  detail: "船跑约55秒触发沉船链",
  acceptance: "给出原因",
};

describe("权限", () => {
  it("只有现任管理者能改账本", async () => {
    const root = project();
    const args = { action: "add", title: "甲", acceptance: "乙" };
    expect((await run(who("w1", "worker", root), args)).error).toBe(true);
    // 角色是管理者、但本进程没被授予管理权的窗口：不行
    expect((await run(who("m2", "manager", root), args)).error).toBe(true);
    expect((await run(who("m1", "manager", root), args)).error).toBe(false);
  });

  it("检查者不能建任务，也不能给还没汇报的任务写结论", async () => {
    const root = project();
    const manager = who("m1", "manager", root);
    const created = await run(manager, { action: "add", title: "甲", acceptance: "乙" });
    const reviewer = who("r1", "reviewer", root);
    expect((await run(reviewer, { action: "add", title: "丙", acceptance: "丁" })).error).toBe(
      true,
    );
    const verdict = await run(reviewer, {
      action: "verdict",
      taskId: created.json.created,
      result: "pass",
      reason: "行",
    });
    expect(verdict.error).toBe(true);
    expect(verdict.text).toContain("待检查");
  });

  it("执行者只看派给自己的，管理者看全部", async () => {
    const root = project();
    const manager = who("m1", "manager", root);
    const a = await run(manager, { action: "add", title: "任务甲", acceptance: "验收甲" });
    await run(manager, { action: "add", title: "另一件完全不同的活", acceptance: "验收乙" });
    await run(manager, { action: "assign", taskId: a.json.created, windowId: "w1" });
    expect((await run(who("w1", "worker", root), { action: "list" })).json.count).toBe(1);
    expect((await run(who("w2", "worker", root), { action: "list" })).json.count).toBe(0);
    expect((await run(manager, { action: "list" })).json.count).toBe(2);
  });
});

describe("重合和拆分", () => {
  it("同主题的未完成任务会被拒绝，force 才能新建", async () => {
    const manager = who("m1", "manager", project());
    expect((await run(manager, SAME)).error).toBe(false);
    const again = await run(manager, SAME);
    expect(again.error).toBe(true);
    expect(again.text).toContain("同主题");
    expect((await run(manager, { ...SAME, force: true })).error).toBe(false);
  });

  it("带 parentId 挂成子任务，子任务下不能再挂", async () => {
    const manager = who("m1", "manager", project());
    const parent = await run(manager, SAME);
    const sub = await run(manager, { ...SAME, parentId: parent.json.created });
    expect(sub.error).toBe(false);
    const deeper = await run(manager, { ...SAME, parentId: sub.json.created });
    expect(deeper.error).toBe(true);
    expect(deeper.text).toContain("一层");
  });

  it("拆成子任务后大任务不能直接派，有先后的要等前一条做完", async () => {
    const manager = who("m1", "manager", project());
    const parent = await run(manager, SAME);
    const split = await run(manager, {
      action: "split",
      parentId: parent.json.created,
      subtasks: [
        { title: "查原因", acceptance: "甲" },
        { title: "修复", acceptance: "乙", after: 1 },
      ],
    });
    const created = (split.json as unknown as { created: { id: string; title: string }[] }).created;
    expect(created).toHaveLength(2);
    const [first, second] = created;
    const direct = await run(manager, {
      action: "assign",
      taskId: parent.json.created,
      windowId: "w1",
    });
    expect(direct.text).toContain("大任务");
    const early = await run(manager, { action: "assign", taskId: second?.id, windowId: "w2" });
    expect(early.text).toContain("做完");
    expect(
      (await run(manager, { action: "assign", taskId: first?.id, windowId: "w1" })).error,
    ).toBe(false);
  });

  it("子任务不到 2 条不能拆", async () => {
    const manager = who("m1", "manager", project());
    const parent = await run(manager, SAME);
    const split = await run(manager, {
      action: "split",
      parentId: parent.json.created,
      subtasks: [{ title: "只有一条", acceptance: "甲" }],
    });
    expect(split.error).toBe(true);
  });
});

describe("免检和取消", () => {
  it("免检结束必须写理由，写了就直接完成并移出未完成", async () => {
    const root = project();
    const manager = who("m1", "manager", root);
    const created = await run(manager, { action: "add", title: "查进度", acceptance: "说清" });
    const id = created.json.created;
    expect((await run(manager, { action: "close", taskId: id })).error).toBe(true);
    expect((await run(manager, { action: "close", taskId: id, waived: true })).error).toBe(true);
    const closed = await run(manager, {
      action: "close",
      taskId: id,
      waived: true,
      reason: "只是查进度",
    });
    expect(closed.json).toMatchObject({ status: "done", waived: true });
    expect((await run(manager, { action: "list" })).json.count).toBe(0);
  });

  it("还有没做完的子任务时不能直接标完成", async () => {
    const manager = who("m1", "manager", project());
    const parent = await run(manager, SAME);
    await run(manager, {
      action: "split",
      parentId: parent.json.created,
      subtasks: [
        { title: "子一", acceptance: "甲" },
        { title: "子二", acceptance: "乙" },
      ],
    });
    const closed = await run(manager, {
      action: "close",
      taskId: parent.json.created,
      waived: true,
      reason: "算了",
    });
    expect(closed.error).toBe(true);
    expect(closed.text).toContain("子任务");
  });

  it("取消大任务连同没做完的子任务", async () => {
    const manager = who("m1", "manager", project());
    const parent = await run(manager, { action: "add", title: "大活", acceptance: "甲" });
    await run(manager, {
      action: "split",
      parentId: parent.json.created,
      subtasks: [
        { title: "子一", acceptance: "甲" },
        { title: "子二", acceptance: "乙" },
      ],
    });
    const cancelled = await run(manager, {
      action: "cancel",
      taskId: parent.json.created,
      reason: "不做了",
    });
    expect(cancelled.json.cancelled).toHaveLength(3);
    expect((await run(manager, { action: "list" })).json.count).toBe(0);
  });
});
