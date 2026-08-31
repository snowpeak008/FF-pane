/**
 * T4.2 会话执行编排器单测：以假适配器 + 假依赖驱动真实 guardTurn + core 生命周期，
 * 覆盖 Planner 流式、Worker 落 Run + 推进任务、受理拒绝、未知轮回执。
 *
 * 不需要真机 CLI：适配器的事件流由脚本化 AgentEvent 数组喂入，存取/密钥/时钟/ID
 * 全为测试替身，落库与状态推进用可观测的假实现断言。
 */

import {
  type AgentAdapter,
  type AgentEvent,
  createAdapterRegistry,
  type McpStdioServerSpec,
} from "@ff-pane/adapters";
import { WORKER_DEFAULT_ENVELOPE } from "@ff-pane/core";
import type {
  AgentProfile,
  GlobalConfig,
  HabitEntry,
  HabitEntryId,
  KnowledgeQueryRecord,
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
  type KnowledgeToolBinding,
  type SessionOrchestratorDeps,
} from "../src/main/session/orchestrator";
import type { SessionStreamEvent, StartSessionRequest } from "../src/shared-ipc/contracts";

/** 记录每次 startTurn 收到的上下文（断言 resume 绑定是否透传）。 */
interface CapturedTurn {
  readonly prompt: string;
  readonly resume?: { readonly nativeSessionId: string; readonly cwd: string };
  readonly configOverrides?: Readonly<Record<string, string>>;
  /** T6.6：本轮注入的 MCP 服务端（未挂知识库工具时缺席）。 */
  readonly mcpServers?: Readonly<Record<string, McpStdioServerSpec>>;
  readonly inheritUserMcpServers?: boolean;
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
        ...(ctx.mcpServers !== undefined ? { mcpServers: ctx.mcpServers } : {}),
        ...(ctx.inheritUserMcpServers !== undefined
          ? { inheritUserMcpServers: ctx.inheritUserMcpServers }
          : {}),
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
  readonly savedPlans: Plan[];
  readonly sessions: Map<string, SessionRecord>;
  readonly captured: CapturedTurn[];
  readonly observedMessages: string[];
  /** T7.2：审查结论回写（updateRun 收到的整条 Run）。 */
  readonly updatedRuns: Run[];
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
    /** 预置习惯条目（Prompt 第 2 层编译测试用；默认空）。 */
    readonly habits?: readonly HabitEntry[];
    /** 注册的 fake 适配器 runtime 键（默认 "fake"，需与 profile.runtime 一致）。 */
    readonly runtime?: string;
    /**
     * T6.6：本轮的知识库工具绑定。缺省 = 完全不注入 prepareKnowledgeTool 依赖
     *（等价于旧行为）；给 null = 注入了但返回 undefined（项目开关关闭那条路径）。
     */
    readonly knowledgeTool?: KnowledgeToolBinding | null;
  } = {},
): Harness {
  const published: SessionStreamEvent[] = [];
  const savedTasks: Task[] = [];
  const persistedRuns: Run[] = [];
  const savedSessions: SessionRecord[] = [];
  const savedPlans: Plan[] = [];
  const captured: CapturedTurn[] = [];
  const observedMessages: string[] = [];
  const updatedRuns: Run[] = [];
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
    loadHabits: async () => opts.habits ?? [],
    observeMessage: (m) => {
      observedMessages.push(m);
    },
    loadStateSnapshot: async () => opts.stateSnapshot,
    loadGlobalConfig: async () => CONFIG,
    loadTask: async () => (opts.task === null ? undefined : (opts.task ?? task())),
    saveTask: async (_l, tk) => {
      savedTasks.push(tk);
    },
    listRuns: async () => opts.runs ?? [],
    loadRun: async (_l, id) => (opts.runs ?? []).find((r) => r.id === id),
    updateRun: async (_l, run) => {
      updatedRuns.push(run);
    },
    listTasks: async () => opts.tasks ?? [],
    loadLatestPlan: async () => opts.latestPlan,
    loadSession: async (_l, id) => sessions.get(id),
    saveSession: async (_l, record) => {
      sessions.set(record.id, record);
      savedSessions.push(record);
    },
    savePlan: async (_l, plan) => {
      savedPlans.push(plan);
    },
    persistRun: async (_l, run) => {
      persistedRuns.push(run);
    },
    ...(opts.knowledgeTool !== undefined
      ? {
          prepareKnowledgeTool: async () =>
            opts.knowledgeTool === null ? undefined : opts.knowledgeTool,
        }
      : {}),
    now: () => 1000,
    newRunId: () => "run-1" as unknown as Run["id"],
    newLocalSessionId: () => "sess-new" as unknown as LocalSessionId,
  };
  return {
    deps,
    published,
    savedTasks,
    persistedRuns,
    savedSessions,
    savedPlans,
    sessions,
    captured,
    observedMessages,
    updatedRuns,
  };
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

/** 习惯条目工厂（Prompt 第 2 层 / 习惯先行测试用）；默认一条 active+enabled 的 workflow 习惯。 */
function habitEntry(o: Partial<HabitEntry> = {}): HabitEntry {
  return {
    id: "hab-x" as HabitEntryId,
    category: "workflow",
    content: "先跑测试再改代码",
    status: "active",
    enabled: true,
    source: { kind: "user_manual" },
    importance: 50,
    createdAt: 1,
    updatedAt: 1,
    ...o,
  } as HabitEntry;
}

/** 构造一条 planner-message 请求（可带 directExecute）。 */
function plannerMessageRequest(text: string, directExecute?: boolean): StartSessionRequest {
  return {
    turnId: "t1",
    projectRoot: "/proj",
    profileId: "prof-1" as unknown as ProfileId,
    input: {
      kind: "planner-message",
      text,
      ...(directExecute === true ? { directExecute: true } : {}),
    },
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

  it("习惯档案：active+enabled 习惯编入 Prompt 第 2 层，停用/候选被排除（T5.2）", async () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "ok", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const mkHabit = (o: Partial<HabitEntry>): HabitEntry =>
      ({
        id: "hab-x" as HabitEntryId,
        category: "workflow",
        content: "先跑测试再改代码",
        status: "active",
        enabled: true,
        source: { kind: "user_manual" },
        importance: 50,
        createdAt: 1,
        updatedAt: 1,
        ...o,
      }) as HabitEntry;
    const h = makeHarness(events, {
      profile: profile({ defaultRole: "planner" }),
      habits: [
        mkHabit({ id: "hab-1" as HabitEntryId, content: "先跑测试再改代码" }),
        mkHabit({ id: "hab-2" as HabitEntryId, content: "停用项", enabled: false }),
        mkHabit({ id: "hab-3" as HabitEntryId, content: "候选项", status: "candidate" }),
      ],
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(plannerRequest());
    await flushUntilEnd(h.published);

    const prompt = h.captured[0]?.prompt ?? "";
    expect(prompt).toContain("# 用户习惯");
    expect(prompt).toContain("先跑测试再改代码");
    expect(prompt).toContain("流程约束（执行前必须遵守）");
    expect(prompt).not.toContain("停用项");
    expect(prompt).not.toContain("候选项");
  });

  describe("习惯先行（T5.3，§8.2.3）", () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "ok", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const MARKER = "【习惯先行】";

    it("planner-message + workflow 习惯 → 追加整形指令", async () => {
      const h = makeHarness(events, {
        profile: profile({ defaultRole: "planner" }),
        habits: [habitEntry({})],
      });
      await createSessionOrchestrator(h.deps).start(plannerMessageRequest("帮我做个登录页"));
      await flushUntilEnd(h.published);
      expect(h.captured[0]?.prompt).toContain(MARKER);
    });

    it("本轮 directExecute=true → 不追加（单次跳过）", async () => {
      const h = makeHarness(events, {
        profile: profile({ defaultRole: "planner" }),
        habits: [habitEntry({})],
      });
      await createSessionOrchestrator(h.deps).start(plannerMessageRequest("帮我做个登录页", true));
      await flushUntilEnd(h.published);
      expect(h.captured[0]?.prompt).not.toContain(MARKER);
    });

    it("消息以「直接做」开头 → 不追加", async () => {
      const h = makeHarness(events, {
        profile: profile({ defaultRole: "planner" }),
        habits: [habitEntry({})],
      });
      await createSessionOrchestrator(h.deps).start(plannerMessageRequest("直接做，别问了"));
      await flushUntilEnd(h.published);
      expect(h.captured[0]?.prompt).not.toContain(MARKER);
    });

    it("只有非 workflow 习惯 → 不追加", async () => {
      const h = makeHarness(events, {
        profile: profile({ defaultRole: "planner" }),
        habits: [habitEntry({ category: "tech", content: "优先 TypeScript" })],
      });
      await createSessionOrchestrator(h.deps).start(plannerMessageRequest("帮我做个登录页"));
      await flushUntilEnd(h.published);
      expect(h.captured[0]?.prompt).not.toContain(MARKER);
    });

    it("planner-plan 轮 + workflow 习惯 → 不追加（计划轮本就是先提方案）", async () => {
      const planJson = JSON.stringify({
        goal: "g",
        tasks: [{ id: "t1", goal: "x", writeScope: ["src/**"], acceptance: ["a"] }],
      });
      const planEvents: AgentEvent[] = [
        { kind: "session_start" },
        {
          kind: "text",
          content: `\`\`\`json\n${planJson}\n\`\`\``,
          final: true,
          channel: "answer",
        },
        { kind: "end", reason: "completed" },
      ];
      const h = makeHarness(planEvents, {
        profile: profile({ defaultRole: "planner" }),
        habits: [habitEntry({})],
      });
      await createSessionOrchestrator(h.deps).start({
        turnId: "t1",
        projectRoot: "/proj",
        profileId: "prof-1" as unknown as ProfileId,
        input: { kind: "planner-plan" },
      });
      await flushUntilEnd(h.published);
      expect(h.captured[0]?.prompt).not.toContain(MARKER);
    });
  });

  describe("来源三观察钩子（T5.4，§8.2.4）", () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "ok", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];

    it("planner-message 轮：以消息原文调用 observeMessage", async () => {
      const h = makeHarness(events, { profile: profile({ defaultRole: "planner" }) });
      await createSessionOrchestrator(h.deps).start(plannerMessageRequest("先说思路再写代码"));
      await flushUntilEnd(h.published);
      expect(h.observedMessages).toEqual(["先说思路再写代码"]);
    });

    it("worker-task 轮：不观察", async () => {
      const h = makeHarness(events, { profile: profile({ defaultRole: "worker" }) });
      await createSessionOrchestrator(h.deps).start(workerRequest());
      await flushUntilEnd(h.published);
      expect(h.observedMessages).toEqual([]);
    });

    it("planner-plan 轮：不观察（计划生成非讨论纠正）", async () => {
      const planJson = JSON.stringify({
        goal: "g",
        tasks: [{ id: "t1", goal: "x", writeScope: ["src/**"], acceptance: ["a"] }],
      });
      const planEvents: AgentEvent[] = [
        { kind: "session_start" },
        {
          kind: "text",
          content: `\`\`\`json\n${planJson}\n\`\`\``,
          final: true,
          channel: "answer",
        },
        { kind: "end", reason: "completed" },
      ];
      const h = makeHarness(planEvents, { profile: profile({ defaultRole: "planner" }) });
      await createSessionOrchestrator(h.deps).start({
        turnId: "t1",
        projectRoot: "/proj",
        profileId: "prof-1" as unknown as ProfileId,
        input: { kind: "planner-plan" },
      });
      await flushUntilEnd(h.published);
      expect(h.observedMessages).toEqual([]);
    });
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

  it("planner-plan 轮（无底稿）：解析计划块 → 落 v1 draft，end 带 planVersion=1（T4.6）", async () => {
    const planJson = JSON.stringify({
      goal: "加个工具函数",
      scope: ["实现 sum"],
      tasks: [{ id: "t1", goal: "实现 sum", writeScope: ["src/**"], acceptance: ["导出 sum"] }],
    });
    const events: AgentEvent[] = [
      { kind: "session_start" },
      {
        kind: "text",
        content: `好的：\n\`\`\`json\n${planJson}\n\`\`\``,
        final: true,
        channel: "answer",
      },
      { kind: "end", reason: "completed" },
    ];
    const h = makeHarness(events, { profile: profile({ defaultRole: "planner" }) });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start({
      turnId: "tp",
      projectRoot: "/proj",
      profileId: "prof-1" as unknown as ProfileId,
      input: { kind: "planner-plan" },
    });
    await flushUntilEnd(h.published);

    expect(h.savedPlans).toHaveLength(1);
    expect(h.savedPlans[0]).toMatchObject({ version: 1, status: "draft", goal: "加个工具函数" });
    expect(h.savedPlans[0]?.tasks[0]).toMatchObject({ id: "t1", planVersion: 1 });
    expect(h.published.find((e) => e.kind === "end")).toMatchObject({
      reason: "completed",
      planVersion: 1,
    });
  });

  it("planner-plan 轮（有活跃底稿）：产 v2 draft 且旧版转 superseded", async () => {
    const base = {
      version: 1,
      status: "draft",
      goal: "旧目标",
      scope: [],
      nonGoals: [],
      constraints: [],
      decisions: [],
      tasks: [],
      acceptance: [],
    } as unknown as Plan;
    const planJson = JSON.stringify({
      goal: "新目标",
      tasks: [{ id: "t1", goal: "做事" }],
    });
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: `\`\`\`json\n${planJson}\n\`\`\``, final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const h = makeHarness(events, {
      profile: profile({ defaultRole: "planner" }),
      latestPlan: base,
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start({
      turnId: "tp2",
      projectRoot: "/proj",
      profileId: "prof-1" as unknown as ProfileId,
      input: { kind: "planner-plan" },
    });
    await flushUntilEnd(h.published);

    // 两次落盘：旧版 supersede + 新版 v2 draft
    expect(h.savedPlans).toHaveLength(2);
    expect(h.savedPlans.find((p) => p.version === 1)?.status).toBe("superseded");
    expect(h.savedPlans.find((p) => p.version === 2)).toMatchObject({
      status: "draft",
      goal: "新目标",
    });
    expect(h.published.find((e) => e.kind === "end")).toMatchObject({ planVersion: 2 });
  });

  it("planner-plan 轮：答复无计划块 → 不落盘，end 带失败原因", async () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "我先聊聊思路，没有给 json。", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const h = makeHarness(events, { profile: profile({ defaultRole: "planner" }) });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start({
      turnId: "tp3",
      projectRoot: "/proj",
      profileId: "prof-1" as unknown as ProfileId,
      input: { kind: "planner-plan" },
    });
    await flushUntilEnd(h.published);

    expect(h.savedPlans).toHaveLength(0);
    const end = h.published.find((e) => e.kind === "end");
    expect(end).toMatchObject({ reason: "completed" });
    expect(end?.kind === "end" && end.message).toContain("计划生成失败");
    expect(end?.kind === "end" && end.planVersion).toBeUndefined();
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

describe("T7.1 跨 Agent 迁移（handoff，§10.4）", () => {
  const HANDOFF = "# 跨 Agent 交接包（工作台生成）\n\n用户改过的那一份";

  /** 一条带原生绑定、且适配器支持原生恢复的既有会话——不迁移时它会走 native。 */
  function resumableSession(): SessionRecord {
    return {
      id: "sess-1" as unknown as LocalSessionId,
      profileId: "prof-1" as unknown as ProfileId,
      role: "planner",
      native: { nativeSessionId: "native-1" as unknown as NativeSessionId, cwd: "/proj" },
      createdAt: 500,
      lastActiveAt: 500,
    } as unknown as SessionRecord;
  }

  function migrationHarness(): ReturnType<typeof makeHarness> {
    return makeHarness(
      [
        { kind: "session_start" },
        { kind: "text", content: "ok", final: true, channel: "answer" },
        { kind: "end", reason: "completed" },
      ],
      {
        profile: profile({ defaultRole: "planner" }),
        nativeResume: "yes",
        existingSession: resumableSession(),
        stateSnapshot: "正在做某事",
      },
    );
  }

  it("带交接包 → resumeKind=handoff，交接包正文前置到提示词", async () => {
    const h = migrationHarness();
    const orch = createSessionOrchestrator(h.deps);

    await orch.start({ ...plannerRequest(), handoffText: HANDOFF });
    await flushUntilEnd(h.published);

    expect(h.published[0]).toMatchObject({ kind: "started", resumeKind: "handoff" });
    expect(h.captured[0]?.prompt.startsWith(HANDOFF)).toBe(true);
  });

  it("强制开新会话：即便传了可原生恢复的 sessionId 也不续接（新 Agent 续不上旧 Agent 的会话）", async () => {
    const h = migrationHarness();
    const orch = createSessionOrchestrator(h.deps);

    const ack = await orch.start({
      ...plannerRequest(),
      sessionId: "sess-1" as unknown as LocalSessionId,
      handoffText: HANDOFF,
    });
    await flushUntilEnd(h.published);

    expect(ack).toMatchObject({ accepted: true, sessionId: "sess-new" });
    expect(h.captured[0]?.resume).toBeUndefined();
    expect(h.sessions.get("sess-new")?.resumeKind).toBe("handoff");
    expect(h.sessions.get("sess-new")?.native).toBeUndefined();
  });

  it("不注入上下文重建文本：迁移不是「续上你自己的历史」", async () => {
    const h = makeHarness(
      [
        { kind: "session_start" },
        { kind: "text", content: "ok", final: true, channel: "answer" },
        { kind: "end", reason: "completed" },
      ],
      {
        profile: profile({ defaultRole: "planner" }),
        nativeResume: "no",
        existingSession: resumableSession(),
        stateSnapshot: "正在做某事",
      },
    );
    const orch = createSessionOrchestrator(h.deps);

    await orch.start({
      ...plannerRequest(),
      sessionId: "sess-1" as unknown as LocalSessionId,
      handoffText: HANDOFF,
    });
    await flushUntilEnd(h.published);

    expect(h.captured[0]?.prompt).not.toContain("会话恢复上下文");
  });

  it("空白交接包按「没给」处理：照常续接，不标 handoff、不插空段落", async () => {
    const h = migrationHarness();
    const orch = createSessionOrchestrator(h.deps);

    await orch.start({
      ...plannerRequest(),
      sessionId: "sess-1" as unknown as LocalSessionId,
      handoffText: "   \n  ",
    });
    await flushUntilEnd(h.published);

    expect(h.published[0]).toMatchObject({ kind: "started", resumeKind: "native" });
    expect(h.captured[0]?.prompt.startsWith("\n")).toBe(false);
  });
});

describe("T6.6 Agent 只读知识库检索工具", () => {
  const SPEC: McpStdioServerSpec = {
    command: "/app/electron",
    args: ["/app/out/main/knowledge-mcp.js"],
    env: { FF_PANE_KNOWLEDGE_DB: "/root/index.sqlite" },
    allowedTools: ["knowledge_search"],
  };

  function binding(
    queries: readonly KnowledgeQueryRecord[],
    overrides: Partial<KnowledgeToolBinding> = {},
  ): KnowledgeToolBinding {
    return {
      serverName: "ffpane-knowledge",
      spec: SPEC,
      readAudit: async () => queries,
      ...overrides,
    };
  }

  function queryRecord(query: string): KnowledgeQueryRecord {
    return {
      calledAt: 900,
      query,
      limit: 8,
      hits: [
        {
          entryId: "e1" as KnowledgeQueryRecord["hits"][number]["entryId"],
          chunkId: "c1" as KnowledgeQueryRecord["hits"][number]["chunkId"],
          title: "使用指南",
          filePath: "docs/guide.md",
          score: 0.5,
          snippet: "片段",
        },
      ],
      usedFts: true,
      usedVector: false,
      durationMs: 4,
    };
  }

  const OK_EVENTS: AgentEvent[] = [
    { kind: "session_start" },
    { kind: "text", content: "done", final: true, channel: "answer" },
    { kind: "end", reason: "completed" },
  ];

  it("项目开关关闭 → 完全不注入：Agent 侧看不到这个工具", async () => {
    const h = makeHarness(OK_EVENTS, { knowledgeTool: null });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(workerRequest());
    await flushUntilEnd(h.published);

    expect(h.captured[0]?.mcpServers).toBeUndefined();
    // 未挂工具 → knowledgeQueries 缺省（与"挂了但没调用"的空数组区分）
    expect(h.persistedRuns[0]?.knowledgeQueries).toBeUndefined();
  });

  it("开关开启 → 按注册名注入 MCP 服务端规格", async () => {
    const h = makeHarness(OK_EVENTS, { knowledgeTool: binding([]) });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(workerRequest());
    await flushUntilEnd(h.published);

    expect(h.captured[0]?.mcpServers).toEqual({ "ffpane-knowledge": SPEC });
  });

  it("缺省不继承用户自己的 MCP 服务端（MCP 工具绕过 §7 权限信封）", async () => {
    const h = makeHarness(OK_EVENTS, { knowledgeTool: binding([]) });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(workerRequest());
    await flushUntilEnd(h.published);

    expect(h.captured[0]?.inheritUserMcpServers).toBeUndefined();
  });

  it("用户显式允许时透传 inheritUserMcpServers", async () => {
    const h = makeHarness(OK_EVENTS, {
      knowledgeTool: binding([], { inheritUserMcpServers: true }),
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(workerRequest());
    await flushUntilEnd(h.published);

    expect(h.captured[0]?.inheritUserMcpServers).toBe(true);
  });

  it("Worker 轮：审计落进 Run.knowledgeQueries 并推 knowledge-query 事件", async () => {
    const records = [queryRecord("RRF 融合"), queryRecord("权限信封")];
    const h = makeHarness(OK_EVENTS, { knowledgeTool: binding(records) });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(workerRequest());
    await flushUntilEnd(h.published);

    expect(h.persistedRuns[0]?.knowledgeQueries).toEqual(records);
    expect(h.published.find((e) => e.kind === "knowledge-query")).toMatchObject({
      queries: records,
    });
  });

  it("挂了但一次没调用 → 空数组（不是缺省）：界面据此说「工具开着但没用上」", async () => {
    const h = makeHarness(OK_EVENTS, { knowledgeTool: binding([]) });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(workerRequest());
    await flushUntilEnd(h.published);

    expect(h.persistedRuns[0]?.knowledgeQueries).toEqual([]);
    // 零调用不推事件（一条"查了 0 次"的通知只是噪声）
    expect(h.published.some((e) => e.kind === "knowledge-query")).toBe(false);
  });

  it("Planner 轮没有 Run，事件是它唯一的可见途径", async () => {
    const records = [queryRecord("检索设计")];
    const h = makeHarness(OK_EVENTS, {
      profile: profile({ defaultRole: "planner" }),
      knowledgeTool: binding(records),
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(plannerRequest());
    await flushUntilEnd(h.published);

    expect(h.persistedRuns).toHaveLength(0);
    expect(h.published.find((e) => e.kind === "knowledge-query")).toMatchObject({
      queries: records,
    });
  });

  it("审计回读失败不拖垮收尾：Run 照常落库", async () => {
    const h = makeHarness(OK_EVENTS, {
      knowledgeTool: binding([], {
        readAudit: async () => {
          throw new Error("审计文件被删了");
        },
      }),
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(workerRequest());
    await flushUntilEnd(h.published);

    expect(h.persistedRuns).toHaveLength(1);
    expect(h.persistedRuns[0]?.knowledgeQueries).toEqual([]);
  });

  it("装配抛错不拖垮整轮：本轮无此工具但照常执行（工具是增强而非前提）", async () => {
    const h = makeHarness(OK_EVENTS, { knowledgeTool: null });
    const deps: SessionOrchestratorDeps = {
      ...h.deps,
      prepareKnowledgeTool: async () => {
        throw new Error("索引库打不开");
      },
    };
    const orch = createSessionOrchestrator(deps);

    const ack = await orch.start(workerRequest());
    await flushUntilEnd(h.published);

    expect(ack.accepted).toBe(true);
    expect(h.captured[0]?.mcpServers).toBeUndefined();
    expect(h.persistedRuns).toHaveLength(1);
  });
});

describe("T7.2 审查轮（reviewer-review，§3.1）", () => {
  /** 被审查的那条 Run：一次跑完的 Worker 尝试，带 diff 与验证结果。 */
  function reviewedRun(overrides: Partial<Run> = {}): Run {
    return {
      id: "run-under-review" as unknown as Run["id"],
      taskId: "task-1" as unknown as TaskId,
      attempt: 1,
      profileId: "prof-worker" as unknown as ProfileId,
      startedAt: 100,
      endedAt: 200,
      endReason: "completed",
      fileChanges: [{ path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }],
      commands: [{ command: "npm test", exitCode: 0 }],
      verifyResult: { command: "npm test", exitCode: 0, output: "all green" },
      report: "做完了",
      rawLogPath: "raw.log",
      ...overrides,
    } as unknown as Run;
  }

  function reviewRequest(runId = "run-under-review"): StartSessionRequest {
    return {
      turnId: "t-review",
      projectRoot: "/proj",
      profileId: "prof-1" as unknown as ProfileId,
      input: {
        kind: "reviewer-review",
        taskId: "task-1" as unknown as TaskId,
        runId: runId as unknown as Run["id"],
      },
    };
  }

  /** 一轮跑完并给出结构化结论的事件流。 */
  function verdictEvents(body: string): AgentEvent[] {
    return [
      { kind: "session_start" },
      { kind: "text", content: body, final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
  }

  const PASS_ANSWER =
    '看过了。\n```json\n{"verdict":"pass","summary":"两条验收标准都满足","findings":[]}\n```';

  function reviewHarness(
    events: readonly AgentEvent[],
    runs: readonly Run[] = [reviewedRun()],
  ): ReturnType<typeof makeHarness> {
    return makeHarness(events, {
      profile: profile({ id: "prof-1", defaultRole: "reviewer" }),
      task: task({ status: "done", verifyCmd: "npm test" }),
      runs,
    });
  }

  it("role=reviewer；结论写回被审的那条 Run，且不铸新 Run、不改任务状态", async () => {
    const h = reviewHarness(verdictEvents(PASS_ANSWER));
    const orch = createSessionOrchestrator(h.deps);

    const ack = await orch.start(reviewRequest());
    await flushUntilEnd(h.published);

    expect(ack.accepted).toBe(true);
    expect(h.published[0]).toMatchObject({ kind: "started", role: "reviewer" });
    // 不铸新 Run：Run 是「任务的一次尝试」，审查不是尝试
    expect(h.persistedRuns).toHaveLength(0);
    // 不推进任务：done ≠ accepted 由 acceptTask 在状态机层锁死（§6.3）
    expect(h.savedTasks).toHaveLength(0);
    expect(h.updatedRuns).toHaveLength(1);
    expect(h.updatedRuns[0]).toMatchObject({
      id: "run-under-review",
      review: { verdict: "pass", summary: "两条验收标准都满足", profileId: "prof-1" },
    });
    // 被审 Run 的原有证据原样保留（回写只加一个字段）
    expect(h.updatedRuns[0]?.report).toBe("做完了");
    expect(h.updatedRuns[0]?.fileChanges).toHaveLength(1);
  });

  it("end 事件带结论与被审 Run 的 id（渲染层据此 toast 并跳转）", async () => {
    const h = reviewHarness(verdictEvents(PASS_ANSWER));
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(reviewRequest());
    await flushUntilEnd(h.published);

    expect(h.published.at(-1)).toMatchObject({
      kind: "end",
      reason: "completed",
      runId: "run-under-review",
      reviewVerdict: "pass",
    });
  });

  it("第 4 层是审查材料：验收标准 + diff + 结论合同，且不含任务合同的执行指令", async () => {
    const h = reviewHarness(verdictEvents(PASS_ANSWER));
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(reviewRequest());
    await flushUntilEnd(h.published);

    const prompt = h.captured[0]?.prompt ?? "";
    expect(prompt).toContain("验收标准");
    expect(prompt).toContain("@@ -1 +1 @@");
    expect(prompt).toContain("审查结论（结构化输出）");
    // 任务合同渲染里的执行指令措辞不该出现（那会把审查者往「我该做点什么」带）
    expect(prompt).not.toContain("可写范围（仅这些路径可改）");
  });

  it("解析不出结论 → inconclusive 并保留原文（绝不猜 pass/fail）", async () => {
    const h = reviewHarness(verdictEvents("我觉得写得挺好的，应该没问题。"));
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(reviewRequest());
    await flushUntilEnd(h.published);

    expect(h.updatedRuns[0]?.review).toMatchObject({
      verdict: "inconclusive",
      summary: "我觉得写得挺好的，应该没问题。",
    });
  });

  it("轮次未跑完（取消/崩溃）→ 不写结论（那是一次没发生的审查，不该覆盖旧结论）", async () => {
    const h = reviewHarness([
      { kind: "session_start" },
      { kind: "text", content: "才看了一半", final: false, channel: "answer" },
      { kind: "end", reason: "cancelled" },
    ]);
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(reviewRequest());
    await flushUntilEnd(h.published);

    expect(h.updatedRuns).toHaveLength(0);
    expect(h.published.at(-1)).toMatchObject({ kind: "end", reason: "cancelled" });
    expect(h.published.at(-1)).not.toHaveProperty("reviewVerdict");
  });

  it("装配的是 Reviewer 信封：合同的验证命令放行并进结论留档（§7 verify_only 白名单）", async () => {
    const h = reviewHarness([
      { kind: "session_start" },
      { kind: "command", command: "npm test", status: "completed", exitCode: 0 },
      { kind: "text", content: PASS_ANSWER, final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ]);
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(reviewRequest());
    await flushUntilEnd(h.published);

    // "它到底验没验"要查得到——一份没跑过命令的 pass 与跑过的不是一个分量
    expect(h.updatedRuns[0]?.review?.commands).toEqual([{ command: "npm test", exitCode: 0 }]);
  });

  it("合同外的命令被权限层掐断整轮 → 不写结论（一次被拦下的审查不是一份结论）", async () => {
    const h = reviewHarness([
      { kind: "session_start" },
      // verify_only 白名单只有任务合同的 npm test；这条越界
      { kind: "command", command: "rm -rf build", status: "completed", exitCode: 0 },
      { kind: "text", content: PASS_ANSWER, final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ]);
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(reviewRequest());
    await flushUntilEnd(h.published);

    expect(h.published.at(-1)).not.toMatchObject({ reason: "completed" });
    expect(h.updatedRuns).toHaveLength(0);
  });

  it("Run 不属于该任务 → 拒绝受理（拿 A 的验收标准审 B 的改动，结论必然是垃圾）", async () => {
    const h = reviewHarness(verdictEvents(PASS_ANSWER), [
      reviewedRun({ taskId: "task-other" as unknown as TaskId }),
    ]);
    const orch = createSessionOrchestrator(h.deps);

    const ack = await orch.start(reviewRequest());

    expect(ack).toMatchObject({ accepted: false });
    expect(h.updatedRuns).toHaveLength(0);
  });

  it("Run 不存在 → 拒绝受理", async () => {
    const h = reviewHarness(verdictEvents(PASS_ANSWER), []);
    const orch = createSessionOrchestrator(h.deps);

    expect(await orch.start(reviewRequest("nope"))).toMatchObject({ accepted: false });
  });
});
