/**
 * T7.4 项目摘要汇总单测（纯逻辑，读取全部由假数据源注入）。
 *
 * 覆盖三件事：三项派生信息算得对、缺数据/坏数据如实降级、一个项目出事不拖垮整个列表。
 */

import type { Plan, ProjectRegistryEntry, Run, SessionRecord, Task } from "@ff-pane/shared";
import type { ProjectLayout } from "@ff-pane/storage";
import { describe, expect, it } from "vitest";
import {
  type ProjectSummarySources,
  summarizeProject,
  summarizeProjects,
} from "../src/main/project-summary";

/** 布局只被当作句柄传递，本模块不解析路径，故给一个最小对象即可。 */
function layoutOf(rootPath: string): ProjectLayout {
  return { projectRootDir: rootPath, workbenchDir: `${rootPath}/.workbench` } as ProjectLayout;
}

/** overrides 用宽松形态：品牌 ID 在测试里逐个 as 会淹没断言本身。 */
function plan(overrides: Partial<Record<keyof Plan, unknown>> = {}): Plan {
  return {
    version: 1,
    status: "draft",
    goal: "g",
    scope: [],
    nonGoals: [],
    constraints: [],
    decisions: [],
    tasks: [],
    acceptance: [],
    ...overrides,
  } as unknown as Plan;
}

function task(overrides: Partial<Record<keyof Task, unknown>> = {}): Task {
  return { id: "task-1", status: "pending", ...overrides } as unknown as Task;
}

function run(overrides: Partial<Record<keyof Run, unknown>> = {}): Run {
  return {
    id: "run-1",
    taskId: "task-1",
    attempt: 1,
    startedAt: 1_000,
    fileChanges: [],
    commands: [],
    rawLogPath: "raw.log",
    ...overrides,
  } as unknown as Run;
}

function session(overrides: Partial<Record<keyof SessionRecord, unknown>> = {}): SessionRecord {
  return {
    id: "sess-1",
    profileId: "prof-1",
    role: "planner",
    createdAt: 1_000,
    lastActiveAt: 1_000,
    ...overrides,
  } as unknown as SessionRecord;
}

function entry(overrides: Partial<Record<keyof ProjectRegistryEntry, unknown>> = {}) {
  return {
    id: "proj-1",
    name: "项目一",
    rootPath: "/tmp/p1",
    createdAt: 1,
    ...overrides,
  } as unknown as ProjectRegistryEntry;
}

interface SourceOverrides {
  readonly workbenchPresent?: ProjectSummarySources["workbenchPresent"];
  readonly plans?: readonly Plan[] | Error;
  readonly tasks?: readonly Task[] | Error;
  readonly runs?: readonly Run[] | Error;
  readonly sessions?: readonly SessionRecord[] | Error;
  readonly resolveLayout?: ProjectSummarySources["resolveLayout"];
}

/** 给定值就返回它，给定 Error 就抛它（模拟坏文件/坏盘）。 */
function reader<T>(value: readonly T[] | Error | undefined): () => Promise<readonly T[]> {
  return async () => {
    if (value instanceof Error) {
      throw value;
    }
    return value ?? [];
  };
}

function sources(overrides: SourceOverrides = {}): ProjectSummarySources {
  return {
    workbenchPresent: overrides.workbenchPresent ?? (async () => true),
    listPlans: reader(overrides.plans),
    listTasks: reader(overrides.tasks),
    listRuns: reader(overrides.runs),
    listSessions: reader(overrides.sessions),
    resolveLayout: overrides.resolveLayout ?? layoutOf,
  };
}

const LAYOUT = layoutOf("/tmp/p1");

describe("summarizeProject —— 当前计划版本与状态", () => {
  it("没有计划 → 版本与状态一并缺席（不造一个 v0）", async () => {
    const summary = await summarizeProject(LAYOUT, sources());
    expect(summary.planVersion).toBeUndefined();
    expect(summary.planStatus).toBeUndefined();
  });

  it("取版本号最大的那份，而非数组末位", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({
        plans: [
          plan({ version: 3, status: "draft" }),
          plan({ version: 1, status: "superseded" }),
          plan({ version: 2, status: "superseded" }),
        ],
      }),
    );
    expect(summary.planVersion).toBe(3);
    expect(summary.planStatus).toBe("draft");
  });

  it("当前版本是草稿也照实报草稿（§11.1 要的是版本与状态，不是「最近一次批准」）", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({ plans: [plan({ version: 1, status: "approved" }), plan({ version: 2 })] }),
    );
    expect(summary).toMatchObject({ planVersion: 2, planStatus: "draft" });
  });
});

describe("summarizeProject —— 进行中任务数", () => {
  it("accepted 与 cancelled 是仅有的两个收尾态，其余五态都算进行中", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({
        tasks: [
          task({ id: "t1", status: "pending" }),
          task({ id: "t2", status: "running" }),
          task({ id: "t3", status: "blocked" }),
          task({ id: "t4", status: "failed" }),
          task({ id: "t5", status: "done" }),
          task({ id: "t6", status: "accepted" }),
          task({ id: "t7", status: "cancelled" }),
        ],
      }),
    );
    expect(summary.activeTaskCount).toBe(5);
    expect(summary.taskCount).toBe(7);
  });

  it("done 计入进行中（§6.3 done ≠ accepted，还等着用户验收）", async () => {
    const summary = await summarizeProject(LAYOUT, sources({ tasks: [task({ status: "done" })] }));
    expect(summary.activeTaskCount).toBe(1);
  });

  it("全部收尾 → 0，但总数仍如实给出", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({
        tasks: [task({ id: "t1", status: "accepted" }), task({ id: "t2", status: "cancelled" })],
      }),
    );
    expect(summary).toMatchObject({ activeTaskCount: 0, taskCount: 2 });
  });
});

describe("summarizeProject —— 最后活动时间", () => {
  it("四路都没有时间点 → 时刻与出处一并缺席（不退回项目登记时间冒充活动）", async () => {
    const summary = await summarizeProject(LAYOUT, sources({ tasks: [task()] }));
    expect(summary.lastActivityAt).toBeUndefined();
    expect(summary.lastActivitySource).toBeUndefined();
  });

  it("取三路里最晚的一个，并带出它的出处", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({
        plans: [plan({ approvedBy: { by: "user", at: 5_000 } })],
        runs: [run({ startedAt: 1_000, endedAt: 2_000 })],
        sessions: [session({ lastActiveAt: 9_000 })],
      }),
    );
    expect(summary).toMatchObject({ lastActivityAt: 9_000, lastActivitySource: "session" });
  });

  it("草稿计划不贡献时间点（计划本身无时间戳，批准是它唯一带时刻的事件）", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({ plans: [plan({ version: 2 })], sessions: [session({ lastActiveAt: 100 })] }),
    );
    expect(summary).toMatchObject({ lastActivityAt: 100, lastActivitySource: "session" });
  });

  it("在飞的 Run（无 endedAt）用起始时刻参与比较", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({ runs: [run({ startedAt: 7_000 })], sessions: [session({ lastActiveAt: 100 })] }),
    );
    expect(summary).toMatchObject({ lastActivityAt: 7_000, lastActivitySource: "run" });
  });

  it("审查时刻晚于 Run 收尾时刻 → 它才是最后一次活动", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({
        runs: [
          run({
            startedAt: 1_000,
            endedAt: 2_000,
            review: {
              reviewedAt: 8_000,
              profileId: "p",
              verdict: "pass",
              summary: "s",
              findings: [],
              commands: [],
            },
          }),
        ],
      }),
    );
    expect(summary).toMatchObject({ lastActivityAt: 8_000, lastActivitySource: "run" });
  });

  it("并列时按 plan → run → session 的固定顺序定，结果确定", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({
        plans: [plan({ approvedBy: { by: "user", at: 4_000 } })],
        runs: [run({ endedAt: 4_000 })],
        sessions: [session({ lastActiveAt: 4_000 })],
      }),
    );
    expect(summary.lastActivitySource).toBe("plan");
  });
});

describe("summarizeProject —— 降级", () => {
  it(".workbench/ 不存在 → 零值 + 明标数据目录缺失，且不去读那四路", async () => {
    let reads = 0;
    const summary = await summarizeProject(LAYOUT, {
      ...sources({
        workbenchPresent: async () => false,
        plans: [plan()],
        tasks: [task()],
      }),
      listPlans: async () => {
        reads += 1;
        return [];
      },
    });
    expect(summary).toEqual({
      workbenchPresent: false,
      activeTaskCount: 0,
      taskCount: 0,
      unavailable: [],
    });
    expect(reads).toBe(0);
  });

  it("目录探测本身抛错（坏盘）→ 按不存在处理，不抛给调用方", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({
        workbenchPresent: async () => {
          throw new Error("EIO");
        },
      }),
    );
    expect(summary.workbenchPresent).toBe(false);
  });

  it("单路读失败只标那一路，其余三路照常出结果", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({
        plans: [plan({ version: 2, status: "approved" })],
        tasks: [task({ status: "running" })],
        runs: [run({ endedAt: 3_000 })],
        sessions: new Error("sessions.json is not valid JSON"),
      }),
    );
    expect(summary.unavailable).toEqual(["session"]);
    expect(summary).toMatchObject({
      planVersion: 2,
      planStatus: "approved",
      activeTaskCount: 1,
      lastActivityAt: 3_000,
      lastActivitySource: "run",
    });
  });

  it("读不到的源不伪装成空：任务读失败时不报 0 个任务，而是标 task 不可用", async () => {
    const summary = await summarizeProject(LAYOUT, sources({ tasks: new Error("corrupt-json") }));
    expect(summary.unavailable).toContain("task");
    expect(summary.taskCount).toBe(0);
  });

  it("四路全坏 → unavailable 按固定顺序列全，且不抛错", async () => {
    const summary = await summarizeProject(
      LAYOUT,
      sources({
        plans: new Error("x"),
        tasks: new Error("x"),
        runs: new Error("x"),
        sessions: new Error("x"),
      }),
    );
    expect(summary.unavailable).toEqual(["plan", "task", "run", "session"]);
    expect(summary.workbenchPresent).toBe(true);
  });
});

describe("summarizeProjects", () => {
  it("逐项目独立汇总，一个项目的坏数据不影响另一个", async () => {
    const badRoot = "/tmp/bad";
    const views = await summarizeProjects(
      [entry({ id: "p1", rootPath: "/tmp/p1" }), entry({ id: "p2", rootPath: badRoot })],
      {
        ...sources({ tasks: [task({ status: "running" })] }),
        listTasks: async (layout) => {
          if (layout.projectRootDir === badRoot) {
            throw new Error("corrupt-json");
          }
          return [task({ status: "running" })];
        },
      },
    );
    expect(views[0]?.summary).toMatchObject({ activeTaskCount: 1, unavailable: [] });
    expect(views[1]?.summary.unavailable).toEqual(["task"]);
  });

  it("整个项目汇总崩掉（路径解析失败）→ 四路全标不可用，其余项目照常返回", async () => {
    const views = await summarizeProjects(
      [entry({ id: "p1", rootPath: "/tmp/p1" }), entry({ id: "p2", rootPath: "" })],
      sources({
        resolveLayout: (rootPath) => {
          if (rootPath === "") {
            throw new Error("invalid project root");
          }
          return layoutOf(rootPath);
        },
      }),
    );
    expect(views).toHaveLength(2);
    expect(views[0]?.summary.workbenchPresent).toBe(true);
    expect(views[1]?.summary).toEqual({
      workbenchPresent: false,
      activeTaskCount: 0,
      taskCount: 0,
      unavailable: ["plan", "task", "run", "session"],
    });
  });

  it("注册表条目原样带出（派生信息与实体分层，不混进一个扁平对象）", async () => {
    const registryEntry = entry({ id: "p9", name: "项目九", rootPath: "/tmp/p9" });
    const views = await summarizeProjects([registryEntry], sources());
    expect(views[0]?.entry).toBe(registryEntry);
  });

  it("空注册表 → 空列表", async () => {
    expect(await summarizeProjects([], sources())).toEqual([]);
  });
});
