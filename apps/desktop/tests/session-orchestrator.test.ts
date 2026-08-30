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
  LocalSessionId,
  NativeSessionId,
  Plan,
  ProfileId,
  Provider,
  Run,
  SessionRecord,
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

/** 记录每次 startTurn 收到的上下文（断言 resume 绑定是否透传）。 */
interface CapturedTurn {
  readonly prompt: string;
  readonly resume?: { readonly nativeSessionId: string; readonly cwd: string };
  readonly configOverrides?: Readonly<Record<string, string>>;
}

function fakeAdapter(
  runtime: string,
  events: readonly AgentEvent[],
  opts: { readonly nativeResume?: "yes" | "no"; readonly captured?: CapturedTurn[] } = {},
): AgentAdapter {
  return {
    runtime,
    displayName: "fake",
    capabilities: () => ({
      nativeResume: opts.nativeResume ?? "no",
      streaming: "yes",
      fileChangeEvents: "yes",
      commandEvents: "yes",
      permissionForwarding: "no",
      gracefulCancel: "yes",
    }),
    startTurn: (ctx) => {
      opts.captured?.push({
        prompt: ctx.prompt,
        ...(ctx.resume !== undefined ? { resume: ctx.resume } : {}),
        ...(ctx.configOverrides !== undefined ? { configOverrides: ctx.configOverrides } : {}),
      });
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
  readonly savedSessions: SessionRecord[];
  readonly sessions: Map<string, SessionRecord>;
  readonly captured: CapturedTurn[];
}

function makeHarness(
  events: readonly AgentEvent[],
  opts: {
    readonly profile?: AgentProfile | null;
    readonly provider?: Provider | null;
    readonly task?: Task | null;
    readonly nativeResume?: "yes" | "no";
    /** 预置会话登记（续接/恢复测试用）。 */
    readonly existingSession?: SessionRecord;
    readonly latestPlan?: Plan;
    readonly tasks?: readonly Task[];
    readonly runs?: readonly Run[];
    readonly stateSnapshot?: string;
    /** 注册的 fake 适配器 runtime 键（默认 "fake"，需与 profile.runtime 一致）。 */
    readonly runtime?: string;
  } = {},
): Harness {
  const published: SessionStreamEvent[] = [];
  const savedTasks: Task[] = [];
  const persistedRuns: Run[] = [];
  const savedSessions: SessionRecord[] = [];
  const captured: CapturedTurn[] = [];
  const sessions = new Map<string, SessionRecord>();
  if (opts.existingSession !== undefined) {
    sessions.set(opts.existingSession.id, opts.existingSession);
  }
  const registry = createAdapterRegistry();
  registry.register(
    fakeAdapter(opts.runtime ?? "fake", events, {
      ...(opts.nativeResume !== undefined ? { nativeResume: opts.nativeResume } : {}),
      captured,
    }),
  );
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
    loadStateSnapshot: async () => opts.stateSnapshot,
    loadGlobalConfig: async () => CONFIG,
    loadTask: async () => (opts.task === null ? undefined : (opts.task ?? task())),
    saveTask: async (_l, tk) => {
      savedTasks.push(tk);
    },
    listRuns: async () => opts.runs ?? [],
    listTasks: async () => opts.tasks ?? [],
    loadLatestPlan: async () => opts.latestPlan,
    loadSession: async (_l, id) => sessions.get(id),
    saveSession: async (_l, record) => {
      sessions.set(record.id, record);
      savedSessions.push(record);
    },
    persistRun: async (_l, run) => {
      persistedRuns.push(run);
    },
    now: () => 1000,
    newRunId: () => "run-1" as unknown as Run["id"],
    newLocalSessionId: () => "sess-new" as unknown as LocalSessionId,
  };
  return { deps, published, savedTasks, persistedRuns, savedSessions, sessions, captured };
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

  it("codex + openai_compatible：把 model_provider 路由经 configOverrides 透传给适配器（方案 A）", async () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "hi", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const h = makeHarness(events, {
      runtime: "codex",
      profile: profile({ defaultRole: "planner", runtime: "codex" }),
      provider: {
        id: "prov-1",
        name: "DeepSeek",
        type: "openai_compatible",
        baseUrl: "https://api.deepseek.com/v1",
        models: [],
        enabled: true,
      } as unknown as Provider,
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(plannerRequest());
    await flushUntilEnd(h.published);

    expect(h.captured[0]?.configOverrides).toMatchObject({
      model_provider: "ffpane",
      "model_providers.ffpane.base_url": '"https://api.deepseek.com/v1"',
      "model_providers.ffpane.env_key": '"OPENAI_API_KEY"',
    });
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

  // --- T4.3 会话恢复 ---

  it("新会话首轮：ack 回传生成的 sessionId，登记一条无 resumeKind 的会话", async () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "hi", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const h = makeHarness(events, { profile: profile({ defaultRole: "planner" }) });
    const orch = createSessionOrchestrator(h.deps);

    const ack = await orch.start(plannerRequest());
    expect(ack).toMatchObject({ accepted: true, sessionId: "sess-new" });
    await flushUntilEnd(h.published);

    expect(h.published[0]).toMatchObject({ kind: "started", sessionId: "sess-new" });
    expect(h.published[0]).not.toHaveProperty("resumeKind");
    const registered = h.sessions.get("sess-new");
    expect(registered).toMatchObject({ role: "planner" });
    expect(registered?.resumeKind).toBeUndefined();
    expect(registered?.native).toBeUndefined();
  });

  it("session_start 报出原生会话 ID → 回写登记原生绑定（ID + cwd 成对）", async () => {
    const events: AgentEvent[] = [
      {
        kind: "session_start",
        native: { nativeSessionId: "native-xyz" as unknown as NativeSessionId, cwd: "/proj" },
      },
      { kind: "text", content: "hi", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const h = makeHarness(events, { profile: profile({ defaultRole: "planner" }) });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(plannerRequest());
    await flushUntilEnd(h.published);

    expect(h.sessions.get("sess-new")?.native).toEqual({
      nativeSessionId: "native-xyz",
      cwd: "/proj",
    });
  });

  it("续接有原生绑定的会话 + 适配器支持原生恢复 → native：透传 resume 绑定，不注入重建上下文", async () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "ok", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const existingSession: SessionRecord = {
      id: "sess-1" as unknown as LocalSessionId,
      profileId: "prof-1" as unknown as ProfileId,
      role: "planner",
      native: { nativeSessionId: "native-1" as unknown as NativeSessionId, cwd: "/proj" },
      createdAt: 500,
      lastActiveAt: 500,
    } as unknown as SessionRecord;
    const h = makeHarness(events, {
      profile: profile({ defaultRole: "planner" }),
      nativeResume: "yes",
      existingSession,
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start({ ...plannerRequest(), sessionId: "sess-1" as unknown as LocalSessionId });
    await flushUntilEnd(h.published);

    expect(h.published[0]).toMatchObject({ kind: "started", resumeKind: "native" });
    expect(h.captured[0]?.resume).toMatchObject({ nativeSessionId: "native-1", cwd: "/proj" });
    expect(h.captured[0]?.prompt).not.toContain("会话恢复上下文");
  });

  it("续接会话但适配器不支持原生恢复 → context_rebuild：注入重建上下文，不透传 resume", async () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "ok", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const existingSession: SessionRecord = {
      id: "sess-1" as unknown as LocalSessionId,
      profileId: "prof-1" as unknown as ProfileId,
      role: "planner",
      createdAt: 500,
      lastActiveAt: 500,
    } as unknown as SessionRecord;
    const h = makeHarness(events, {
      profile: profile({ defaultRole: "planner" }),
      nativeResume: "no",
      existingSession,
      stateSnapshot: "正在做某事",
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start({ ...plannerRequest(), sessionId: "sess-1" as unknown as LocalSessionId });
    await flushUntilEnd(h.published);

    expect(h.published[0]).toMatchObject({ kind: "started", resumeKind: "context_rebuild" });
    expect(h.captured[0]?.resume).toBeUndefined();
    expect(h.captured[0]?.prompt).toContain("会话恢复上下文");
    expect(h.captured[0]?.prompt).toContain("正在做某事");
  });
});
