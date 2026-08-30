/**
 * T4.2 会话执行编排器单测：以假适配器 + 假依赖驱动真实 guardTurn + core 生命周期，
 * 覆盖 Planner 流式、Worker 落 Run + 推进任务、受理拒绝、未知轮回执。
 *
 * 不需要真机 CLI：适配器的事件流由脚本化 AgentEvent 数组喂入，存取/密钥/时钟/ID
 * 全为测试替身，落库与状态推进用可观测的假实现断言。
 */

import { type AgentAdapter, type AgentEvent, createAdapterRegistry } from "@ff-pane/adapters";
import { WORKER_DEFAULT_ENVELOPE } from "@ff-pane/core";
import type {
  AgentProfile,
  GlobalConfig,
  ProfileId,
  Provider,
  Run,
  Task,
  TaskId,
} from "@ff-pane/shared";
import type { ProjectLayout } from "@ff-pane/storage";
import { describe, expect, it } from "vitest";
import {
  createSessionOrchestrator,
  type SessionOrchestratorDeps,
} from "../src/main/session/orchestrator";
import type { SessionStreamEvent, StartSessionRequest } from "../src/shared-ipc/contracts";

function fakeAdapter(runtime: string, events: readonly AgentEvent[]): AgentAdapter {
  return {
    runtime,
    displayName: "fake",
    capabilities: () => ({
      nativeResume: "no",
      streaming: "yes",
      fileChangeEvents: "yes",
      commandEvents: "yes",
      permissionForwarding: "no",
      gracefulCancel: "yes",
    }),
    startTurn: () => ({
      events: (async function* () {
        for (const e of events) {
          yield e;
        }
      })(),
      cancel: async () => {},
    }),
  };
}

function profile(overrides: Partial<Record<keyof AgentProfile, unknown>> = {}): AgentProfile {
  return {
    id: "prof-1",
    name: "P",
    runtime: "fake",
    providerId: "prov-1",
    defaultRole: "worker",
    permissionPreset: WORKER_DEFAULT_ENVELOPE,
    ...overrides,
  } as unknown as AgentProfile;
}

function provider(): Provider {
  return {
    id: "prov-1",
    name: "V",
    type: "cli_login",
    models: [],
    enabled: true,
  } as unknown as Provider;
}

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
    status: "pending",
    ...overrides,
  } as unknown as Task;
}

const CONFIG = { aiOutputLanguage: "zh-CN" } as unknown as GlobalConfig;

interface Harness {
  readonly deps: SessionOrchestratorDeps;
  readonly published: SessionStreamEvent[];
  readonly savedTasks: Task[];
  readonly persistedRuns: Run[];
}

function makeHarness(
  events: readonly AgentEvent[],
  opts: {
    readonly profile?: AgentProfile | null;
    readonly provider?: Provider | null;
    readonly task?: Task | null;
  } = {},
): Harness {
  const published: SessionStreamEvent[] = [];
  const savedTasks: Task[] = [];
  const persistedRuns: Run[] = [];
  const registry = createAdapterRegistry();
  registry.register(fakeAdapter("fake", events));
  const layout = {} as ProjectLayout;

  const deps: SessionOrchestratorDeps = {
    registry,
    publish: (e) => {
      published.push(e);
    },
    loadProfile: async () => (opts.profile === null ? undefined : (opts.profile ?? profile())),
    loadProvider: async () => (opts.provider === null ? undefined : (opts.provider ?? provider())),
    revealSecret: async () => undefined,
    resolveLayout: () => layout,
    loadActiveMemory: async () => [],
    loadStateSnapshot: async () => undefined,
    loadGlobalConfig: async () => CONFIG,
    loadTask: async () => (opts.task === null ? undefined : (opts.task ?? task())),
    saveTask: async (_l, tk) => {
      savedTasks.push(tk);
    },
    listRuns: async () => [],
    persistRun: async (_l, run) => {
      persistedRuns.push(run);
    },
    now: () => 1000,
    newRunId: () => "run-1" as unknown as Run["id"],
  };
  return { deps, published, savedTasks, persistedRuns };
}

async function flushUntilEnd(published: readonly SessionStreamEvent[]): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (published.some((e) => e.kind === "end")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function plannerRequest(): StartSessionRequest {
  return {
    turnId: "t1",
    projectRoot: "/proj",
    profileId: "prof-1" as unknown as ProfileId,
    input: { kind: "planner-message", text: "hi" },
  };
}

function workerRequest(): StartSessionRequest {
  return {
    turnId: "t2",
    projectRoot: "/proj",
    profileId: "prof-1" as unknown as ProfileId,
    input: { kind: "worker-task", taskId: "task-1" as unknown as TaskId },
  };
}

describe("createSessionOrchestrator", () => {
  it("Planner 轮：推 started → text → end，不触碰任务", async () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "hello", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const h = makeHarness(events, { profile: profile({ defaultRole: "planner" }) });
    const orch = createSessionOrchestrator(h.deps);

    const ack = await orch.start(plannerRequest());
    expect(ack.accepted).toBe(true);
    await flushUntilEnd(h.published);

    expect(h.published[0]).toMatchObject({ kind: "started", role: "planner" });
    expect(h.published.find((e) => e.kind === "text")).toMatchObject({ delta: "hello" });
    expect(h.published.find((e) => e.kind === "end")).toMatchObject({ reason: "completed" });
    expect(h.savedTasks).toHaveLength(0);
    expect(orch.activeCount()).toBe(0);
  });

  it("Worker 轮：派发 → 落 Run → completeTask（done），推 end 带 runId", async () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      {
        kind: "file_change",
        path: "src/a.ts",
        changeKind: "add",
        status: "completed",
        diff: "@@ +a",
      },
      { kind: "text", content: "done", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const h = makeHarness(events);
    const orch = createSessionOrchestrator(h.deps);

    const ack = await orch.start(workerRequest());
    expect(ack.accepted).toBe(true);
    await flushUntilEnd(h.published);

    expect(h.savedTasks.map((t) => t.status)).toEqual(["running", "done"]);
    expect(h.persistedRuns).toHaveLength(1);
    expect(h.persistedRuns[0]?.fileChanges).toHaveLength(1);
    expect(h.persistedRuns[0]?.endReason).toBe("completed");
    expect(h.published.find((e) => e.kind === "end")).toMatchObject({
      reason: "completed",
      runId: "run-1",
    });
  });

  it("失败结束的 Worker 轮：任务转 failed，不 done", async () => {
    const events: AgentEvent[] = [
      { kind: "text", content: "boom", final: true, channel: "answer" },
      { kind: "end", reason: "failed", message: "runtime error" },
    ];
    const h = makeHarness(events);
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(workerRequest());
    await flushUntilEnd(h.published);

    expect(h.savedTasks.map((t) => t.status)).toEqual(["running", "failed"]);
    expect(h.persistedRuns[0]?.endReason).toBe("failed");
  });

  it("Profile 不存在 → 不受理", async () => {
    const h = makeHarness([], { profile: null });
    const orch = createSessionOrchestrator(h.deps);
    const ack = await orch.start(plannerRequest());
    expect(ack.accepted).toBe(false);
  });

  it("Runtime 未注册 → 不受理", async () => {
    const h = makeHarness([], { profile: profile({ runtime: "missing", defaultRole: "planner" }) });
    const orch = createSessionOrchestrator(h.deps);
    const ack = await orch.start(plannerRequest());
    expect(ack.accepted).toBe(false);
  });

  it("未知轮的回执 / 取消返回 ok:false", async () => {
    const h = makeHarness([]);
    const orch = createSessionOrchestrator(h.deps);
    expect(
      await orch.respondPermission({ turnId: "x", requestId: "r", decision: "allow" }),
    ).toEqual({ ok: false });
    expect(await orch.cancel({ turnId: "x" })).toEqual({ ok: false });
  });
});
