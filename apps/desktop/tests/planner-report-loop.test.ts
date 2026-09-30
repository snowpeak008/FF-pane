/**
 * T9.10 Planner 跟进回路（第一档）单测：
 *
 * 1. ① 结算入队接缝（enqueueSettlementIfSettled）：落定三态各生成摘要入队、
 *    非落定态不入队、摘要带最近 Run 细节、入队失败吞掉不波及落定路径；
 * 2. ② 编排器注入：planner-message / planner-plan 轮 prompt 前置「任务看板增量」
 *    （含待汇报队列与基准 diff）、Worker / 审查轮不注入、依赖缺省时零行为；
 * 3. ② 消费语义：受理成功（spawn 已发生）才消费（清队列 + 换基准，基准快照 =
 *    本轮开始时的看板）；受理失败（Profile 缺失 / spawn 同步抛错）不消费——摘要不丢；
 * 4. 红线守卫（合同验收「无任何自动触发 Planner 轮的路径」）：
 *    a. 行为面——Worker 轮落定入队后编排器无新轮（started 事件恰一次、activeCount 0）；
 *    b. 依赖面——settlement 接缝与 storage 队列层的源码不引用编排器 / 不发起会话。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentAdapter, type AgentEvent, createAdapterRegistry } from "@ff-pane/adapters";
import {
  REPORT_CONTEXT_HEADING,
  REPORT_DELTA_HEADING,
  REPORT_QUEUE_HEADING,
  WORKER_DEFAULT_ENVELOPE,
} from "@ff-pane/core";
import type {
  AgentProfile,
  GlobalConfig,
  PlannerBoardBaseline,
  PlannerReportState,
  ProfileId,
  Provider,
  Run,
  SettlementReportEntry,
  Task,
  TaskId,
} from "@ff-pane/shared";
import type { ProjectLayout } from "@ff-pane/storage";
import { describe, expect, it } from "vitest";
import {
  createSessionOrchestrator,
  type SessionOrchestratorDeps,
} from "../src/main/session/orchestrator";
import type { ProfileAdapterResolver } from "../src/main/session/registry";
import {
  enqueueSettlementIfSettled,
  type SettlementEnqueueDeps,
} from "../src/main/session/settlement";
import type { SessionStreamEvent, StartSessionRequest } from "../src/shared-ipc/contracts";

const LAYOUT = {} as ProjectLayout;

function task(overrides: Partial<Record<keyof Task, unknown>> = {}): Task {
  return {
    id: "task-1",
    planVersion: 1,
    goal: "do the thing",
    writeScope: ["**"],
    forbidden: [],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["ok"],
    status: "done",
    ...overrides,
  } as unknown as Task;
}

function run(overrides: Partial<Record<keyof Run, unknown>> = {}): Run {
  return {
    id: "run-9",
    taskId: "task-1",
    attempt: 3,
    profileId: "prof-1",
    startedAt: 500,
    endedAt: 900,
    endReason: "completed",
    fileChanges: [],
    commands: [],
    rawLogPath: "raw.log",
    report: "完成了改动",
    ...overrides,
  } as unknown as Run;
}

/** 最小编排器 harness（照 session-orchestrator.test.ts 款式，本文件只要 T9.10 面）。 */
interface LoopHarness {
  readonly deps: SessionOrchestratorDeps;
  readonly published: SessionStreamEvent[];
  readonly capturedPrompts: string[];
  readonly consumedBaselines: PlannerBoardBaseline[];
  readonly persistedRuns: Run[];
  readonly savedTasks: Task[];
}

function fakeAdapter(events: readonly AgentEvent[], capturedPrompts: string[]): AgentAdapter {
  return {
    runtime: "fake",
    displayName: "fake",
    capabilities: () => ({
      nativeResume: "no",
      streaming: "yes",
      fileChangeEvents: "yes",
      commandEvents: "yes",
      permissionForwarding: "no",
      gracefulCancel: "yes",
    }),
    startTurn: (ctx) => {
      capturedPrompts.push(ctx.prompt);
      return {
        events: (async function* () {
          for (const e of events) {
            yield e;
          }
        })(),
        cancel: async () => {},
      };
    },
  };
}

function makeLoopHarness(
  events: readonly AgentEvent[],
  opts: {
    readonly profile?: AgentProfile | null;
    readonly task?: Task;
    readonly tasks?: readonly Task[];
    readonly plannerReport?: PlannerReportState;
    readonly adapter?: AgentAdapter;
  } = {},
): LoopHarness {
  const published: SessionStreamEvent[] = [];
  const capturedPrompts: string[] = [];
  const consumedBaselines: PlannerBoardBaseline[] = [];
  const persistedRuns: Run[] = [];
  const savedTasks: Task[] = [];
  const registry = createAdapterRegistry();
  registry.register(opts.adapter ?? fakeAdapter(events, capturedPrompts));
  const resolver: ProfileAdapterResolver = {
    resolveForProfile: (p) => {
      const adapter = registry.get(p.runtime);
      return adapter === undefined
        ? { ok: false, reason: `Runtime 未注册：${p.runtime}` }
        : { ok: true, adapter };
    },
  };
  const defaultProfile = {
    id: "prof-1",
    name: "P",
    runtime: "fake",
    providerId: "prov-1",
    defaultRole: "planner",
    permissionPreset: WORKER_DEFAULT_ENVELOPE,
  } as unknown as AgentProfile;

  const deps: SessionOrchestratorDeps = {
    registry: resolver,
    publish: (e) => {
      published.push(e);
    },
    loadProfile: async () => (opts.profile === null ? undefined : (opts.profile ?? defaultProfile)),
    loadProvider: async () =>
      ({
        id: "prov-1",
        name: "V",
        templateId: "local-login",
        models: [],
        enabled: true,
      }) as unknown as Provider,
    revealSecret: async () => undefined,
    resolveLayout: () => LAYOUT,
    loadActiveMemory: async () => [],
    loadHabits: async () => [],
    loadStateSnapshot: async () => undefined,
    loadGlobalConfig: async () => ({ aiOutputLanguage: "zh-CN" }) as unknown as GlobalConfig,
    loadTask: async () => opts.task,
    saveTask: async (_l, saved) => {
      savedTasks.push(saved);
    },
    listRuns: async () => persistedRuns,
    loadRun: async () => undefined,
    updateRun: async () => {},
    listTasks: async () => opts.tasks ?? [],
    loadLatestPlan: async () => undefined,
    loadSession: async () => undefined,
    saveSession: async () => {},
    savePlan: async () => {},
    persistRun: async (_l, persisted) => {
      persistedRuns.push(persisted);
    },
    appendTranscript: async () => {},
    readRecentTranscript: async () => [],
    writeInflightMarker: async () => {},
    deleteInflightMarker: async () => {},
    writeInflightPartial: async () => {},
    now: () => 1000,
    newRunId: () => "run-new" as unknown as Run["id"],
    newLocalSessionId: () => "sess-new" as never,
    ...(opts.plannerReport !== undefined
      ? {
          readPlannerReport: async () => opts.plannerReport as PlannerReportState,
          consumePlannerReport: async (_l: ProjectLayout, baseline: PlannerBoardBaseline) => {
            consumedBaselines.push(baseline);
          },
        }
      : {}),
  };
  return { deps, published, capturedPrompts, consumedBaselines, persistedRuns, savedTasks };
}

async function flushUntilEnd(published: readonly SessionStreamEvent[]): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (published.some((e) => e.kind === "end")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 可观测的入队依赖（enqueue 累积进数组）。 */
function settlementHarness(runs: readonly Run[] = []): {
  readonly deps: SettlementEnqueueDeps;
  readonly enqueued: SettlementReportEntry[];
  readonly logs: string[];
} {
  const enqueued: SettlementReportEntry[] = [];
  const logs: string[] = [];
  return {
    deps: {
      listRuns: async () => runs,
      enqueue: async (_l, entry) => {
        enqueued.push(entry);
      },
      now: () => 7777,
      log: (message) => logs.push(message),
    },
    enqueued,
    logs,
  };
}

describe("T9.10 ① Worker 落定结算摘要入队（saveTask 落盘点接缝）", () => {
  it("落定三态（done / failed / blocked）各生成摘要入队", async () => {
    for (const status of ["done", "failed", "blocked"] as const) {
      const h = settlementHarness();
      const settled = await enqueueSettlementIfSettled(h.deps, LAYOUT, task({ status }));
      expect(settled, status).toBe(true);
      expect(h.enqueued, status).toHaveLength(1);
      expect(h.enqueued[0]).toMatchObject({ taskId: "task-1", status, settledAt: 7777 });
      expect(h.enqueued[0]?.summary).toContain("task-1");
    }
  });

  it("非落定态（pending / running / accepted / cancelled）不入队", async () => {
    for (const status of ["pending", "running", "accepted", "cancelled"] as const) {
      const h = settlementHarness();
      const settled = await enqueueSettlementIfSettled(h.deps, LAYOUT, task({ status }));
      expect(settled, status).toBe(false);
      expect(h.enqueued, status).toHaveLength(0);
    }
  });

  it("摘要取该任务最近一条 Run 的细节（attempt / 报告首行 / runId），他任务的 Run 不掺和", async () => {
    const h = settlementHarness([
      run({ id: "run-old", startedAt: 100, attempt: 1, report: "旧的" }),
      run({ id: "run-9", startedAt: 500, attempt: 3, report: "完成了改动" }),
      run({ id: "run-other", taskId: "task-2", startedAt: 900, report: "别的任务" }),
    ]);
    await enqueueSettlementIfSettled(h.deps, LAYOUT, task({ status: "done" }));
    expect(h.enqueued[0]?.runId).toBe("run-9");
    expect(h.enqueued[0]?.summary).toContain("第 3 次尝试");
    expect(h.enqueued[0]?.summary).toContain("完成了改动");
    expect(h.enqueued[0]?.summary).not.toContain("别的任务");
  });

  it("无 Run（修正路径）给简版摘要照样入队；listRuns 读失败同样不挡", async () => {
    const enqueued: SettlementReportEntry[] = [];
    const deps: SettlementEnqueueDeps = {
      listRuns: async () => {
        throw new Error("disk gone");
      },
      enqueue: async (_l, entry) => {
        enqueued.push(entry);
      },
      now: () => 1,
    };
    expect(await enqueueSettlementIfSettled(deps, LAYOUT, task({ status: "failed" }))).toBe(true);
    expect(enqueued[0]?.summary).toContain("执行失败");
    expect(enqueued[0]?.runId).toBeUndefined();
  });

  it("入队落盘失败吞掉只记日志（落定入队挂在任务落盘必经之路，绝不上抛）", async () => {
    const logs: string[] = [];
    const deps: SettlementEnqueueDeps = {
      listRuns: async () => [],
      enqueue: async () => {
        throw new Error("write failed");
      },
      now: () => 1,
      log: (message) => logs.push(message),
    };
    await expect(enqueueSettlementIfSettled(deps, LAYOUT, task({ status: "done" }))).resolves.toBe(
      false,
    );
    expect(logs.some((line) => line.includes("settlement enqueue failed"))).toBe(true);
  });
});

const PLANNER_EVENTS: AgentEvent[] = [
  { kind: "session_start" },
  { kind: "text", content: "ok", final: true, channel: "answer" },
  { kind: "end", reason: "completed" },
];

function reportState(): PlannerReportState {
  return {
    baseline: { plannerTurnAt: 100, taskStatuses: { "task-1": "running" } },
    queue: [
      {
        taskId: "task-1" as TaskId,
        status: "failed",
        summary: "任务 task-1「do the thing」执行失败（第 1 次尝试）",
        settledAt: 900,
      },
    ],
  };
}

function plannerReq(kind: "planner-message" | "planner-plan"): StartSessionRequest {
  return {
    turnId: "t1",
    projectRoot: "/proj",
    profileId: "prof-1" as unknown as ProfileId,
    input: kind === "planner-message" ? { kind, text: "hi" } : { kind },
  };
}

describe("T9.10 ② Planner 轮开始自动注入任务看板增量", () => {
  it("planner-message 轮：prompt 前置注入节，含待汇报队列摘要与看板变化", async () => {
    const h = makeLoopHarness(PLANNER_EVENTS, {
      plannerReport: reportState(),
      tasks: [task({ status: "failed" })],
    });
    const ack = await createSessionOrchestrator(h.deps).start(plannerReq("planner-message"));
    expect(ack.accepted).toBe(true);
    await flushUntilEnd(h.published);

    const prompt = h.capturedPrompts[0] ?? "";
    expect(prompt).toContain(REPORT_CONTEXT_HEADING);
    expect(prompt).toContain(REPORT_QUEUE_HEADING);
    expect(prompt).toContain("执行失败（第 1 次尝试）");
    expect(prompt).toContain(REPORT_DELTA_HEADING);
    expect(prompt).toContain("running → failed");
    // 注入节前置于正文（角色定义之前），紧挨本轮输入的排布由组装层保证
    expect(prompt.indexOf(REPORT_CONTEXT_HEADING)).toBeLessThan(prompt.indexOf("# 角色"));
  });

  it("planner-plan 轮同样注入（任一 Planner 轮开始，合同原文）", async () => {
    const h = makeLoopHarness(PLANNER_EVENTS, {
      plannerReport: reportState(),
      tasks: [task({ status: "failed" })],
    });
    const ack = await createSessionOrchestrator(h.deps).start(plannerReq("planner-plan"));
    expect(ack.accepted).toBe(true);
    await flushUntilEnd(h.published);
    expect(h.capturedPrompts[0]).toContain(REPORT_CONTEXT_HEADING);
  });

  it("Worker 轮不注入（战况正是它产生的），队列不被消费", async () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "done", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const h = makeLoopHarness(events, {
      task: task({ status: "pending" }),
      plannerReport: reportState(),
      tasks: [task({ status: "pending" })],
    });
    const ack = await createSessionOrchestrator(h.deps).start({
      turnId: "t2",
      projectRoot: "/proj",
      profileId: "prof-1" as unknown as ProfileId,
      input: { kind: "worker-task", taskId: "task-1" as unknown as TaskId },
    });
    expect(ack.accepted).toBe(true);
    await flushUntilEnd(h.published);
    expect(h.capturedPrompts[0] ?? "").not.toContain(REPORT_CONTEXT_HEADING);
    expect(h.consumedBaselines).toHaveLength(0);
  });

  it("无战况（空队列 + 看板与基准一致）不占提示词，但仍消费换基准", async () => {
    const h = makeLoopHarness(PLANNER_EVENTS, {
      plannerReport: {
        baseline: { plannerTurnAt: 100, taskStatuses: { "task-1": "running" } },
        queue: [],
      },
      tasks: [task({ status: "running" })],
    });
    const ack = await createSessionOrchestrator(h.deps).start(plannerReq("planner-message"));
    expect(ack.accepted).toBe(true);
    await flushUntilEnd(h.published);
    expect(h.capturedPrompts[0] ?? "").not.toContain(REPORT_CONTEXT_HEADING);
    // 基准照样换：下一轮的「自上次 Planner 轮以来」从本轮起算
    expect(h.consumedBaselines).toHaveLength(1);
  });

  it("依赖缺省（宿主未接跟进回路）：零注入零消费，旧装配路径不变", async () => {
    const h = makeLoopHarness(PLANNER_EVENTS, {});
    const ack = await createSessionOrchestrator(h.deps).start(plannerReq("planner-message"));
    expect(ack.accepted).toBe(true);
    await flushUntilEnd(h.published);
    expect(h.capturedPrompts[0] ?? "").not.toContain(REPORT_CONTEXT_HEADING);
    expect(h.consumedBaselines).toHaveLength(0);
  });
});

describe("T9.10 ② 消费语义：成功开始才出队", () => {
  it("受理成功即消费：基准 = 本轮开始时刻 + 当前看板快照", async () => {
    const h = makeLoopHarness(PLANNER_EVENTS, {
      plannerReport: reportState(),
      tasks: [task({ status: "failed" }), task({ id: "task-2", status: "pending" })],
    });
    const ack = await createSessionOrchestrator(h.deps).start(plannerReq("planner-message"));
    expect(ack.accepted).toBe(true);
    await flushUntilEnd(h.published);

    expect(h.consumedBaselines).toHaveLength(1);
    expect(h.consumedBaselines[0]).toEqual({
      plannerTurnAt: 1000,
      taskStatuses: { "task-1": "failed", "task-2": "pending" },
    });
  });

  it("受理失败（Profile 不存在）不消费——摘要不丢，下轮再报", async () => {
    const h = makeLoopHarness(PLANNER_EVENTS, {
      profile: null,
      plannerReport: reportState(),
      tasks: [task()],
    });
    const ack = await createSessionOrchestrator(h.deps).start(plannerReq("planner-message"));
    expect(ack.accepted).toBe(false);
    expect(h.consumedBaselines).toHaveLength(0);
  });

  it("spawn 同步抛错（评估轮启动失败）不消费", async () => {
    const h = makeLoopHarness([], {
      adapter: {
        runtime: "fake",
        displayName: "boom",
        capabilities: () => ({
          nativeResume: "no",
          streaming: "yes",
          fileChangeEvents: "yes",
          commandEvents: "yes",
          permissionForwarding: "no",
          gracefulCancel: "yes",
        }),
        startTurn: () => {
          throw new Error("spawn failed");
        },
      },
      plannerReport: reportState(),
      tasks: [task()],
    });
    const ack = await createSessionOrchestrator(h.deps).start(plannerReq("planner-message"));
    expect(ack.accepted).toBe(false);
    expect(h.consumedBaselines).toHaveLength(0);
  });

  it("消费落盘失败只记日志不挡轮（最坏是下一轮重复汇报，比丢报好）", async () => {
    const h = makeLoopHarness(PLANNER_EVENTS, {
      plannerReport: reportState(),
      tasks: [task()],
    });
    const deps = {
      ...h.deps,
      consumePlannerReport: async () => {
        throw new Error("consume write failed");
      },
    };
    const ack = await createSessionOrchestrator(deps).start(plannerReq("planner-message"));
    expect(ack.accepted).toBe(true);
    await flushUntilEnd(h.published);
    expect(h.published.find((e) => e.kind === "end")).toMatchObject({ reason: "completed" });
  });
});

describe("T9.10 红线守卫：无任何自动触发 Planner 轮的路径", () => {
  it("行为面：Worker 轮落定 + 结算入队后，编排器无新轮（started 恰一次、活轮归零）", async () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "done", final: true, channel: "answer" },
      { kind: "end", reason: "failed", message: "boom" },
    ];
    const h = makeLoopHarness(events, { task: task({ status: "pending" }) });
    const enqueued: SettlementReportEntry[] = [];
    // 真实装配的形状：saveTask 落盘点旁接 enqueueSettlementIfSettled（同 index.ts onTaskSaved）
    const deps = {
      ...h.deps,
      saveTask: async (layout: ProjectLayout, saved: Task) => {
        await h.deps.saveTask(layout, saved);
        await enqueueSettlementIfSettled(
          {
            listRuns: async () => h.persistedRuns,
            enqueue: async (_l, entry) => {
              enqueued.push(entry);
            },
            now: () => 9999,
          },
          layout,
          saved,
        );
      },
    };
    const orch = createSessionOrchestrator(deps);
    const ack = await orch.start({
      turnId: "t-guard",
      projectRoot: "/proj",
      profileId: "prof-1" as unknown as ProfileId,
      input: { kind: "worker-task", taskId: "task-1" as unknown as TaskId },
    });
    expect(ack.accepted).toBe(true);
    await flushUntilEnd(h.published);

    // 落定路径确实走到了：任务 failed 已入队
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.status).toBe("failed");
    // 红线：没有任何自动触发的第二轮——started 事件恰一次、无在飞轮残留
    expect(h.published.filter((e) => e.kind === "started")).toHaveLength(1);
    expect(orch.activeCount()).toBe(0);
  });

  it("依赖面：结算接缝与队列存储层不引用编排器、不发起会话（源码钉子）", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const settlementSrc = readFileSync(
      join(here, "..", "src", "main", "session", "settlement.ts"),
      "utf8",
    );
    const queueSrc = readFileSync(
      join(here, "..", "..", "..", "packages", "storage", "src", "sessions", "planner-report.ts"),
      "utf8",
    );
    for (const [name, src] of [
      ["settlement.ts", settlementSrc],
      ["planner-report.ts", queueSrc],
    ] as const) {
      expect(src, `${name} 不得引用编排器`).not.toMatch(/from\s+"\.\/orchestrator"/);
      expect(src, `${name} 不得发起会话轮`).not.toContain("session:start");
      expect(src, `${name} 不得持有 SessionOrchestrator`).not.toContain("SessionOrchestrator");
    }
  });
});
