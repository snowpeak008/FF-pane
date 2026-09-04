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
  InflightTurnMarker,
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
  TranscriptEntry,
} from "@ff-pane/shared";
import type { ProjectLayout } from "@ff-pane/storage";
import { describe, expect, it, vi } from "vitest";
import {
  CANCEL_UNREGISTER_GRACE_MS,
  createSessionOrchestrator,
  type KnowledgeToolBinding,
  type SessionOrchestratorDeps,
} from "../src/main/session/orchestrator";
import type { ProfileAdapterResolver } from "../src/main/session/registry";
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

/**
 * 裸键注册表 → ProfileAdapterResolver（T8.4b）：编排器单测不关心复合键装配
 * （那归 session-registry.test.ts），这里按 profile.runtime 直查裸键，
 * 未注册的拒绝文案与真实装配层一致。
 */
function bareResolver(registry: ReturnType<typeof createAdapterRegistry>): ProfileAdapterResolver {
  return {
    resolveForProfile: (p) => {
      const adapter = registry.get(p.runtime);
      return adapter === undefined
        ? { ok: false, reason: `Runtime 未注册：${p.runtime}` }
        : { ok: true, adapter };
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
  /** T8.2b：按会话累积的回放本条目（appendTranscript 的落点）。 */
  readonly transcripts: Map<string, TranscriptEntry[]>;
  /** T8.2b：当前仍存在的在飞标记（写入即 set，删除即 delete）。 */
  readonly markers: Map<string, InflightTurnMarker>;
  /** T8.2b：partial 覆盖写的历史（每次写入 push 一份快照）。 */
  readonly partialWrites: { readonly turnId: string; readonly text: string }[];
  /** 可推进的假时钟（partial 时间阈值测试用）。 */
  readonly clock: { now: number };
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
    /** T8.2b：预置某会话的回放本（续接轮对话摘录测试用）。 */
    readonly existingTranscript?: readonly TranscriptEntry[];
    /** 自定义假适配器（如"永不结束的流"）；给出时忽略 events / runtime / nativeResume。 */
    readonly adapter?: AgentAdapter;
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
  const transcripts = new Map<string, TranscriptEntry[]>();
  const markers = new Map<string, InflightTurnMarker>();
  const partialWrites: { readonly turnId: string; readonly text: string }[] = [];
  const clock = { now: 1000 };
  const sessions = new Map<string, SessionRecord>();
  if (opts.existingSession !== undefined) {
    sessions.set(opts.existingSession.id, opts.existingSession);
    if (opts.existingTranscript !== undefined) {
      transcripts.set(opts.existingSession.id, [...opts.existingTranscript]);
    }
  }
  const registry = createAdapterRegistry();
  registry.register(
    opts.adapter ??
      fakeAdapter(opts.runtime ?? "fake", events, {
        ...(opts.nativeResume !== undefined ? { nativeResume: opts.nativeResume } : {}),
        captured,
      }),
  );
  const layout = {} as ProjectLayout;

  const deps: SessionOrchestratorDeps = {
    registry: bareResolver(registry),
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
    appendTranscript: async (_l, sessionId, entry) => {
      const list = transcripts.get(sessionId) ?? [];
      list.push(entry);
      transcripts.set(sessionId, list);
    },
    readRecentTranscript: async (_l, sessionId, tail) => {
      const list = transcripts.get(sessionId) ?? [];
      return list.slice(Math.max(0, list.length - tail));
    },
    writeInflightMarker: async (_l, marker) => {
      markers.set(marker.turnId, marker);
    },
    deleteInflightMarker: async (_l, turnId) => {
      markers.delete(turnId);
    },
    writeInflightPartial: async (_l, turnId, text) => {
      partialWrites.push({ turnId, text });
    },
    now: () => clock.now,
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
    transcripts,
    markers,
    partialWrites,
    clock,
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

describe("T8.2b 对话回放本与中断收尾", () => {
  const OK_EVENTS: AgentEvent[] = [
    { kind: "session_start" },
    { kind: "text", content: "第一段，", final: false, channel: "answer" },
    { kind: "text", content: "第二段。", final: true, channel: "answer" },
    { kind: "end", reason: "completed" },
  ];

  /**
   * 永不结束的流：只吐一段文本然后挂住，直到 cancel 才以 cancelled 收尾。
   * 模拟"Worker 正在跑、用户关了应用"。
   */
  function hangingAdapter(captured: { cancels: number }, text = "才写了一半"): AgentAdapter {
    return {
      runtime: "fake",
      displayName: "hanging",
      capabilities: () => ({
        nativeResume: "no",
        streaming: "yes",
        fileChangeEvents: "yes",
        commandEvents: "yes",
        permissionForwarding: "no",
        gracefulCancel: "yes",
      }),
      startTurn: () => {
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          events: (async function* () {
            yield { kind: "session_start" } as AgentEvent;
            yield { kind: "text", content: text, final: false, channel: "answer" } as AgentEvent;
            await gate;
            yield { kind: "end", reason: "cancelled" } as AgentEvent;
          })(),
          cancel: async () => {
            captured.cancels += 1;
            release?.();
          },
        };
      },
    };
  }

  function entriesOf(h: Harness, sessionId = "sess-new"): readonly TranscriptEntry[] {
    return h.transcripts.get(sessionId) ?? [];
  }

  it("Planner 讨论轮：开始写标记 + user_message（原文）；收尾 assistant_message（全文）+ turn_end，标记已删", async () => {
    const h = makeHarness(OK_EVENTS, { profile: profile({ defaultRole: "planner" }) });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(plannerMessageRequest("帮我做个登录页"));
    await flushUntilEnd(h.published);

    expect(entriesOf(h)).toEqual([
      { kind: "user_message", turnId: "t1", at: 1000, text: "帮我做个登录页" },
      { kind: "assistant_message", turnId: "t1", at: 1000, text: "第一段，第二段。" },
      {
        kind: "turn_end",
        turnId: "t1",
        at: 1000,
        role: "planner",
        profileId: "prof-1",
        endReason: "completed",
      },
    ]);
    // 只记用户可见输入：系统提示 / 记忆 / 习惯拼出来的文本不进回放本
    const userEntry = entriesOf(h)[0];
    expect(userEntry?.kind === "user_message" && userEntry.text).not.toContain("#");
    expect(h.markers.size).toBe(0);
  });

  it("Worker 轮：user_message 记任务目标 + taskId；turn_end 带 runId / taskId", async () => {
    const h = makeHarness(OK_EVENTS);
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(workerRequest());
    await flushUntilEnd(h.published);

    const entries = entriesOf(h);
    expect(entries[0]).toMatchObject({
      kind: "user_message",
      text: "do the thing",
      taskId: "task-1",
    });
    expect(entries.at(-1)).toMatchObject({
      kind: "turn_end",
      role: "worker",
      runId: "run-1",
      taskId: "task-1",
      endReason: "completed",
    });
    expect(h.markers.size).toBe(0);
  });

  it("审查轮：user_message / turn_end 都带被审 Run 的 runId 与 taskId", async () => {
    const reviewed = {
      id: "run-under-review" as unknown as Run["id"],
      taskId: "task-1" as unknown as TaskId,
      attempt: 1,
      profileId: "prof-worker" as unknown as ProfileId,
      startedAt: 100,
      endedAt: 200,
      endReason: "completed",
      fileChanges: [],
      commands: [],
      report: "做完了",
      rawLogPath: "raw.log",
    } as unknown as Run;
    const h = makeHarness(OK_EVENTS, {
      profile: profile({ defaultRole: "reviewer" }),
      task: task({ status: "done" }),
      runs: [reviewed],
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start({
      turnId: "t-review",
      projectRoot: "/proj",
      profileId: "prof-1" as unknown as ProfileId,
      input: { kind: "reviewer-review", taskId: reviewed.taskId, runId: reviewed.id },
    });
    await flushUntilEnd(h.published);

    expect(entriesOf(h)[0]).toMatchObject({
      kind: "user_message",
      taskId: "task-1",
      runId: "run-under-review",
    });
    expect(entriesOf(h).at(-1)).toMatchObject({
      kind: "turn_end",
      role: "reviewer",
      runId: "run-under-review",
      taskId: "task-1",
    });
  });

  it("失败 / 取消结束同样落 turn_end（endReason 如实）；无文本则不写 assistant_message", async () => {
    const h = makeHarness([{ kind: "end", reason: "failed", message: "boom" }], {
      profile: profile({ defaultRole: "planner" }),
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(plannerRequest());
    await flushUntilEnd(h.published);

    expect(entriesOf(h).map((e) => e.kind)).toEqual(["user_message", "turn_end"]);
    expect(entriesOf(h).at(-1)).toMatchObject({ kind: "turn_end", endReason: "failed" });
  });

  it("续接轮的 turn_end 记 resumeKind；标记里也带（供修正时沿用）", async () => {
    const existingSession: SessionRecord = {
      id: "sess-1" as unknown as LocalSessionId,
      profileId: "prof-1" as unknown as ProfileId,
      role: "planner",
      createdAt: 500,
      lastActiveAt: 500,
    } as unknown as SessionRecord;
    const seenMarkers: InflightTurnMarker[] = [];
    const h = makeHarness(OK_EVENTS, {
      profile: profile({ defaultRole: "planner" }),
      nativeResume: "no",
      existingSession,
    });
    const deps: SessionOrchestratorDeps = {
      ...h.deps,
      writeInflightMarker: async (l, marker) => {
        seenMarkers.push(marker);
        await h.deps.writeInflightMarker(l, marker);
      },
    };
    const orch = createSessionOrchestrator(deps);

    await orch.start({ ...plannerRequest(), sessionId: existingSession.id });
    await flushUntilEnd(h.published);

    expect(seenMarkers[0]).toMatchObject({
      turnId: "t1",
      sessionId: "sess-1",
      role: "planner",
      resumeKind: "context_rebuild",
    });
    expect(entriesOf(h, "sess-1").at(-1)).toMatchObject({
      kind: "turn_end",
      resumeKind: "context_rebuild",
    });
  });

  it("context_rebuild：该会话回放本的最近对话进提示词「最近对话摘录」", async () => {
    const existingSession: SessionRecord = {
      id: "sess-1" as unknown as LocalSessionId,
      profileId: "prof-1" as unknown as ProfileId,
      role: "planner",
      createdAt: 500,
      lastActiveAt: 500,
    } as unknown as SessionRecord;
    const h = makeHarness(OK_EVENTS, {
      profile: profile({ defaultRole: "planner" }),
      nativeResume: "no",
      existingSession,
      existingTranscript: [
        { kind: "user_message", turnId: "t0", at: 1, text: "上次聊到登录页的表单校验" },
        { kind: "assistant_message", turnId: "t0", at: 2, text: "建议用 zod", partial: true },
        {
          kind: "turn_end",
          turnId: "t0",
          at: 3,
          role: "planner",
          profileId: "prof-1" as ProfileId,
          endReason: "interrupted",
        },
      ],
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start({ ...plannerRequest(), sessionId: existingSession.id });
    await flushUntilEnd(h.published);

    const prompt = h.captured[0]?.prompt ?? "";
    expect(prompt).toContain("## 最近对话摘录");
    expect(prompt).toContain("用户：上次聊到登录页的表单校验");
    expect(prompt).toContain("助手（被中断，不完整）：建议用 zod");
    expect(prompt).not.toContain("interrupted");
  });

  it("native 恢复不读回放本进提示词（原生会话自带历史）", async () => {
    const existingSession: SessionRecord = {
      id: "sess-1" as unknown as LocalSessionId,
      profileId: "prof-1" as unknown as ProfileId,
      role: "planner",
      native: { nativeSessionId: "native-1" as unknown as NativeSessionId, cwd: "/proj" },
      createdAt: 500,
      lastActiveAt: 500,
    } as unknown as SessionRecord;
    const h = makeHarness(OK_EVENTS, {
      profile: profile({ defaultRole: "planner" }),
      nativeResume: "yes",
      existingSession,
      existingTranscript: [{ kind: "user_message", turnId: "t0", at: 1, text: "旧话" }],
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start({ ...plannerRequest(), sessionId: existingSession.id });
    await flushUntilEnd(h.published);

    expect(h.captured[0]?.prompt).not.toContain("最近对话摘录");
  });

  it("回放本 / 标记写失败不影响本轮（记录不是轮次的前提）", async () => {
    const h = makeHarness(OK_EVENTS, { profile: profile({ defaultRole: "planner" }) });
    const deps: SessionOrchestratorDeps = {
      ...h.deps,
      appendTranscript: async () => {
        throw new Error("disk full");
      },
      writeInflightMarker: async () => {
        throw new Error("disk full");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const orch = createSessionOrchestrator(deps);
      const ack = await orch.start(plannerRequest());
      await flushUntilEnd(h.published);

      expect(ack.accepted).toBe(true);
      expect(h.published.at(-1)).toMatchObject({ kind: "end", reason: "completed" });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  describe("partial 节流", () => {
    it("累计 ≥ 2 KB 触发覆盖写；小于阈值且时间未到不写", async () => {
      const small = "a".repeat(100);
      const big = "b".repeat(2_100);
      const h = makeHarness(
        [
          { kind: "session_start" },
          { kind: "text", content: small, final: false, channel: "answer" },
          { kind: "text", content: big, final: false, channel: "answer" },
          { kind: "text", content: small, final: true, channel: "answer" },
          { kind: "end", reason: "completed" },
        ],
        { profile: profile({ defaultRole: "planner" }) },
      );
      const orch = createSessionOrchestrator(h.deps);

      await orch.start(plannerRequest());
      await flushUntilEnd(h.published);

      // 只有累计过阈值的那一次落盘；快照是当时的全部累计文本
      expect(h.partialWrites).toHaveLength(1);
      expect(h.partialWrites[0]).toEqual({ turnId: "t1", text: `${small}${big}` });
    });

    it("距上次落盘 ≥ 2 s 触发（慢速流靠时间兜底）", async () => {
      const h = makeHarness([], { profile: profile({ defaultRole: "planner" }) });
      // 用可推进时钟的适配器：每段文本之间把时钟拨快
      const clock = h.clock;
      const adapter: AgentAdapter = {
        runtime: "fake",
        displayName: "slow",
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
            yield { kind: "session_start" } as AgentEvent;
            yield { kind: "text", content: "一", final: false, channel: "answer" } as AgentEvent;
            clock.now += 2_500;
            yield { kind: "text", content: "二", final: false, channel: "answer" } as AgentEvent;
            yield { kind: "text", content: "三", final: true, channel: "answer" } as AgentEvent;
            yield { kind: "end", reason: "completed" } as AgentEvent;
          })(),
          cancel: async () => {},
        }),
      };
      const registry = createAdapterRegistry();
      registry.register(adapter);
      const orch = createSessionOrchestrator({ ...h.deps, registry: bareResolver(registry) });

      await orch.start(plannerRequest());
      await flushUntilEnd(h.published);

      expect(h.partialWrites).toEqual([{ turnId: "t1", text: "一二" }]);
    });
  });

  describe("prepareForQuit", () => {
    it("Worker 轮在飞 → 写齐三件：transcript（partial + interrupted）、Run(interrupted)、任务 failed；标记删除；随后取消子进程", async () => {
      const cancels = { cancels: 0 };
      const h = makeHarness([], { adapter: hangingAdapter(cancels) });
      const orch = createSessionOrchestrator(h.deps);

      await orch.start(workerRequest());
      // 让流吐出 session_start 与那段文本
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(orch.activeCount()).toBe(1);
      expect(h.markers.has("t2")).toBe(true);

      const report = await orch.prepareForQuit();
      expect(report).toEqual({ interrupted: 1, cancelledInTime: true });
      expect(cancels.cancels).toBe(1);

      // ① transcript
      expect(entriesOf(h)).toEqual([
        { kind: "user_message", turnId: "t2", at: 1000, text: "do the thing", taskId: "task-1" },
        { kind: "assistant_message", turnId: "t2", at: 1000, text: "才写了一半", partial: true },
        {
          kind: "turn_end",
          turnId: "t2",
          at: 1000,
          role: "worker",
          profileId: "prof-1",
          runId: "run-1",
          taskId: "task-1",
          endReason: "interrupted",
        },
      ]);
      // ② Run(interrupted)，report 为部分文本
      expect(h.persistedRuns).toHaveLength(1);
      expect(h.persistedRuns[0]).toMatchObject({
        id: "run-1",
        endReason: "interrupted",
        report: "才写了一半",
      });
      // ③ 任务 running → failed
      expect(h.savedTasks.map((t) => t.status)).toEqual(["running", "failed"]);
      // 标记已删
      expect(h.markers.size).toBe(0);
      expect(h.published.at(-1)).toMatchObject({
        kind: "end",
        reason: "interrupted",
        runId: "run-1",
      });

      // 流随后以 cancelled 收尾，正常 finalize 必须放手：不写第二条 Run / 第二个 turn_end
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(h.persistedRuns).toHaveLength(1);
      expect(entriesOf(h).filter((e) => e.kind === "turn_end")).toHaveLength(1);
      expect(orch.activeCount()).toBe(0);
    });

    it("Planner 轮在飞 → 只写 transcript（partial + interrupted）与删标记，不铸 Run", async () => {
      const cancels = { cancels: 0 };
      const h = makeHarness([], {
        adapter: hangingAdapter(cancels),
        profile: profile({ defaultRole: "planner" }),
      });
      const orch = createSessionOrchestrator(h.deps);

      await orch.start(plannerMessageRequest("聊聊"));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const report = await orch.prepareForQuit();
      expect(report.interrupted).toBe(1);
      expect(h.persistedRuns).toHaveLength(0);
      expect(h.savedTasks).toHaveLength(0);
      expect(entriesOf(h).map((e) => e.kind)).toEqual([
        "user_message",
        "assistant_message",
        "turn_end",
      ]);
      expect(entriesOf(h).at(-1)).toMatchObject({ role: "planner", endReason: "interrupted" });
      expect(h.markers.size).toBe(0);
    });

    it("无在飞轮 → 空报告；重入不重复收尾", async () => {
      const cancels = { cancels: 0 };
      const h = makeHarness([], { adapter: hangingAdapter(cancels) });
      const orch = createSessionOrchestrator(h.deps);
      expect(await orch.prepareForQuit()).toEqual({ interrupted: 0, cancelledInTime: true });

      await orch.start(workerRequest());
      await new Promise((resolve) => setTimeout(resolve, 10));
      const [first, second] = await Promise.all([orch.prepareForQuit(), orch.prepareForQuit()]);
      expect(first.interrupted + second.interrupted).toBe(1);
      expect(h.persistedRuns).toHaveLength(1);
      expect(entriesOf(h).filter((e) => e.kind === "turn_end")).toHaveLength(1);
    });

    it("Run 落盘失败仍把任务拉回 failed（否则重启后永远「执行中」）", async () => {
      const cancels = { cancels: 0 };
      const h = makeHarness([], { adapter: hangingAdapter(cancels) });
      const deps: SessionOrchestratorDeps = {
        ...h.deps,
        persistRun: async () => {
          throw new Error("disk full");
        },
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const orch = createSessionOrchestrator(deps);
        await orch.start(workerRequest());
        await new Promise((resolve) => setTimeout(resolve, 10));
        await orch.prepareForQuit();

        expect(h.savedTasks.map((t) => t.status)).toEqual(["running", "failed"]);
        // Run 没落成 → turn_end 不带 runId
        expect(entriesOf(h).at(-1)).toMatchObject({ kind: "turn_end", endReason: "interrupted" });
        expect(entriesOf(h).at(-1)).not.toHaveProperty("runId");
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe("T8.3a 在飞轮次表（listActiveTurns）", () => {
  /** 挂住的适配器：每轮独立 gate，cancel 才收尾（复用 T8.2b 的形态，支持多轮并存）。 */
  function hangingAdapter(): AgentAdapter {
    return {
      runtime: "fake",
      displayName: "hanging",
      capabilities: () => ({
        nativeResume: "no",
        streaming: "yes",
        fileChangeEvents: "yes",
        commandEvents: "yes",
        permissionForwarding: "no",
        gracefulCancel: "yes",
      }),
      startTurn: () => {
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          events: (async function* () {
            yield { kind: "session_start" } as AgentEvent;
            await gate;
            yield { kind: "end", reason: "cancelled" } as AgentEvent;
          })(),
          cancel: async () => {
            release?.();
          },
        };
      },
    };
  }

  it("Worker 轮登记装配后信封的 writePaths（任务 writeScope 与角色默认的交集），Planner 轮为空集", async () => {
    const h = makeHarness([], {
      adapter: hangingAdapter(),
      task: task({ writeScope: ["src/app"] }),
    });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(workerRequest());
    h.clock.now = 2000;
    await orch.start({ ...plannerRequest(), input: { kind: "planner-message", text: "聊聊" } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const turns = orch.listActiveTurns("/proj");
    // 按 startedAt 升序：Worker（1000）在前、Planner（2000）在后
    expect(turns.map((r) => [r.turnId, r.role, r.startedAt])).toEqual([
      ["t2", "worker", 1000],
      ["t1", "planner", 2000],
    ]);
    // writePaths 是装配后信封（"**" ∩ "src/app" = "src/app"），不是任务合同原文的照抄语义
    expect(turns[0]).toMatchObject({
      taskId: "task-1",
      sessionId: "sess-new",
      writePaths: ["src/app"],
    });
    // Planner 角色默认不可写 → 空集（= 无写权限，与任何轮可并行）
    expect(turns[1]?.writePaths).toEqual([]);
    expect(turns[1]).not.toHaveProperty("taskId");

    await orch.prepareForQuit();
  });

  it("按项目根过滤：大小写 / 分隔符差异视为同一项目，别的项目看不到", async () => {
    const h = makeHarness([], { adapter: hangingAdapter() });
    const orch = createSessionOrchestrator(h.deps);
    await orch.start(workerRequest());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(orch.listActiveTurns("/proj")).toHaveLength(1);
    // Windows 现实：同一路径的大小写 / 反斜杠写法应命中同一项目
    expect(orch.listActiveTurns("\\PROJ")).toHaveLength(1);
    expect(orch.listActiveTurns("/other")).toHaveLength(0);

    await orch.prepareForQuit();
  });

  it("轮次结束（正常收尾）即从表中注销", async () => {
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "text", content: "ok", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const h = makeHarness(events, { profile: profile({ defaultRole: "planner" }) });
    const orch = createSessionOrchestrator(h.deps);

    await orch.start(plannerRequest());
    await flushUntilEnd(h.published);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(orch.listActiveTurns("/proj")).toEqual([]);
    expect(orch.activeCount()).toBe(0);
  });
});

describe("T8.3b 并发受理与互斥拒绝", () => {
  /** 每轮一个可外部驱动的事件队列（并发交错测试用）。 */
  interface ScriptController {
    push(event: AgentEvent): void;
    /** 关闭事件流（push 完 end 后调用；不 push end 直接 close = 模拟流截断）。 */
    close(): void;
  }

  /**
   * 可脚本化的多轮适配器：每次 startTurn 领一个 controller，测试侧按需交错推事件。
   * cancelEndsStream=false 模拟「cancel 后事件流悬挂」的缺陷适配器（僵尸注销用例）。
   */
  function scriptableAdapter(
    controllers: ScriptController[],
    opts: { readonly cancelEndsStream?: boolean } = {},
  ): AgentAdapter {
    const cancelEnds = opts.cancelEndsStream ?? true;
    return {
      runtime: "fake",
      displayName: "scriptable",
      capabilities: () => ({
        nativeResume: "no",
        streaming: "yes",
        fileChangeEvents: "yes",
        commandEvents: "yes",
        permissionForwarding: "no",
        gracefulCancel: "yes",
      }),
      startTurn: () => {
        const queue: AgentEvent[] = [];
        let closed = false;
        let wake: (() => void) | undefined;
        const controller: ScriptController = {
          push(event) {
            queue.push(event);
            wake?.();
          },
          close() {
            closed = true;
            wake?.();
          },
        };
        controllers.push(controller);
        return {
          events: (async function* () {
            for (;;) {
              while (queue.length > 0) {
                yield queue.shift() as AgentEvent;
              }
              if (closed) {
                return;
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          })(),
          cancel: async () => {
            if (cancelEnds) {
              controller.push({ kind: "end", reason: "cancelled" });
              controller.close();
            }
          },
        };
      },
    };
  }

  /** 多任务 + 递增 runId + rawLog 记录的并发测试架子。 */
  function parallelHarness(
    tasks: readonly Task[],
    opts: { readonly cancelEndsStream?: boolean } = {},
  ): {
    readonly h: Harness;
    readonly orch: ReturnType<typeof createSessionOrchestrator>;
    readonly controllers: ScriptController[];
    readonly rawLogs: Map<string, string>;
  } {
    const controllers: ScriptController[] = [];
    const h = makeHarness([], { adapter: scriptableAdapter(controllers, opts) });
    const rawLogs = new Map<string, string>();
    let runSeq = 0;
    const deps: SessionOrchestratorDeps = {
      ...h.deps,
      loadTask: async (_l, id) => tasks.find((t) => t.id === id),
      newRunId: () => {
        runSeq += 1;
        return `run-${runSeq}` as unknown as Run["id"];
      },
      persistRun: async (_l, run, rawLog) => {
        h.persistedRuns.push(run);
        rawLogs.set(String(run.id), rawLog);
      },
    };
    return { h, orch: createSessionOrchestrator(deps), controllers, rawLogs };
  }

  function workerReq(turnId: string, taskId: string, projectRoot = "/proj"): StartSessionRequest {
    return {
      turnId,
      projectRoot,
      profileId: "prof-1" as unknown as ProfileId,
      input: { kind: "worker-task", taskId: taskId as unknown as TaskId },
    };
  }

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

  const TASK_APP = task({ id: "task-app", writeScope: ["src/app"] });
  const TASK_LIB = task({ id: "task-lib", writeScope: ["src/lib"] });
  const TASK_SUB = task({ id: "task-sub", writeScope: ["src/app/sub"] });

  it("writePaths 不相交的两个 Worker 轮真正并发：都受理、交错流式、Run 证据各自落盘不串", async () => {
    const { h, orch, controllers, rawLogs } = parallelHarness([TASK_APP, TASK_LIB]);

    const ackA = await orch.start(workerReq("tA", "task-app"));
    const ackB = await orch.start(workerReq("tB", "task-lib"));
    expect(ackA.accepted).toBe(true);
    expect(ackB.accepted).toBe(true);
    expect(orch.activeCount()).toBe(2);
    expect(orch.listActiveTurns("/proj").map((r) => r.taskId)).toEqual(["task-app", "task-lib"]);

    const [a, b] = controllers;
    if (a === undefined || b === undefined) {
      throw new Error("两轮都该已 startTurn");
    }
    // 两轮事件交错到达：文本与文件改动互相穿插
    a.push({ kind: "session_start" });
    b.push({ kind: "session_start" });
    a.push({
      kind: "file_change",
      path: "src/app/a.ts",
      changeKind: "add",
      status: "completed",
      diff: "@@ +A",
    });
    b.push({ kind: "text", content: "B 报告", final: false, channel: "answer" });
    a.push({ kind: "text", content: "A 报告", final: false, channel: "answer" });
    b.push({
      kind: "file_change",
      path: "src/lib/b.ts",
      changeKind: "add",
      status: "completed",
      diff: "@@ +B",
    });
    a.push({ kind: "end", reason: "completed" });
    b.push({ kind: "end", reason: "completed" });
    a.close();
    b.close();
    await flush();

    // 两条 Run 各自成立，证据不串：A 的 Run 只有 A 的文件与报告，B 同理
    expect(h.persistedRuns).toHaveLength(2);
    const runA = h.persistedRuns.find((r) => r.taskId === ("task-app" as unknown as TaskId));
    const runB = h.persistedRuns.find((r) => r.taskId === ("task-lib" as unknown as TaskId));
    expect(runA?.fileChanges.map((c) => c.path)).toEqual(["src/app/a.ts"]);
    expect(runB?.fileChanges.map((c) => c.path)).toEqual(["src/lib/b.ts"]);
    expect(runA?.report).toBe("A 报告");
    expect(runB?.report).toBe("B 报告");
    expect(runA?.id).not.toBe(runB?.id);
    // raw.log 按 runId 隔离（persistRun 逐 Run 单独收到各自的原始文本）
    expect(rawLogs.get(String(runA?.id))).toBe("A 报告");
    expect(rawLogs.get(String(runB?.id))).toBe("B 报告");
    // 两轮都注销
    expect(orch.activeCount()).toBe(0);
    expect(orch.listActiveTurns("/proj")).toEqual([]);
  });

  it("相交任务被拒绝并行：ack 走 conflicts 分支、reason 人可读；任务不被推进 running、不写在飞标记", async () => {
    const { h, orch } = parallelHarness([TASK_APP, TASK_SUB]);

    await orch.start(workerReq("tA", "task-app"));
    const savedBefore = h.savedTasks.length;
    const ack = await orch.start(workerReq("tB", "task-sub"));

    expect(ack.accepted).toBe(false);
    if (ack.accepted) {
      throw new Error("unreachable");
    }
    expect(ack.conflicts).toBeDefined();
    expect(ack.conflicts?.[0]).toMatchObject({
      candidateId: "task-sub",
      inflightId: "task-app",
      candidatePath: "src/app/sub",
      inflightPath: "src/app",
      relation: "containment",
    });
    // reason 四要素齐备（哪两个任务、哪两条路径、何种关系）
    expect(ack.reason).toContain("task-sub");
    expect(ack.reason).toContain("task-app");
    expect(ack.reason).toContain("src/app/sub");
    // 被拒的派发无副作用：任务保持原状（dispatchTask 推迟到裁决通过后）、无标记、无登记
    expect(h.savedTasks.length).toBe(savedBefore);
    expect(h.markers.has("tB")).toBe(false);
    expect(orch.activeCount()).toBe(1);
    expect(orch.listActiveTurns("/proj").map((r) => r.turnId)).toEqual(["tA"]);

    await orch.prepareForQuit();
  });

  it("Planner 轮与 Worker 轮可并行（空 writePaths = 无写权限，天然放行）", async () => {
    const { orch } = parallelHarness([TASK_APP]);

    await orch.start(workerReq("tA", "task-app"));
    const ack = await orch.start({
      turnId: "tP",
      projectRoot: "/proj",
      profileId: "prof-1" as unknown as ProfileId,
      input: { kind: "planner-message", text: "聊聊" },
    });
    expect(ack.accepted).toBe(true);
    expect(orch.activeCount()).toBe(2);

    await orch.prepareForQuit();
  });

  it("并发受理防竞态：两个相交派发同时进入 start，恰好一个被受理", async () => {
    const { orch } = parallelHarness([TASK_APP, TASK_SUB]);

    const [ackA, ackB] = await Promise.all([
      orch.start(workerReq("tA", "task-app")),
      orch.start(workerReq("tB", "task-sub")),
    ]);
    const accepted = [ackA, ackB].filter((a) => a.accepted);
    expect(accepted).toHaveLength(1);
    expect(orch.activeCount()).toBe(1);

    await orch.prepareForQuit();
  });

  it("在飞轮正常结束后其并行事实即释放：此前被拒的相交任务重派即放行（T8.3a 验收 §3-④ 覆盖缺口）", async () => {
    const { orch, controllers } = parallelHarness([TASK_APP, TASK_SUB]);

    await orch.start(workerReq("tA", "task-app"));
    const rejected = await orch.start(workerReq("tB", "task-sub"));
    expect(rejected.accepted).toBe(false);

    // A 正常收尾 → drain 的 finally 注销并行事实（单删 parallelTable 注销行即此处显形：
    // 残留登记会让下面的重派仍被拒绝）
    const a = controllers[0];
    if (a === undefined) {
      throw new Error("tA 该已 startTurn");
    }
    a.push({ kind: "text", content: "ok", final: true, channel: "answer" });
    a.push({ kind: "end", reason: "completed" });
    a.close();
    await flush();

    const retried = await orch.start(workerReq("tB2", "task-sub"));
    expect(retried.accepted).toBe(true);

    await orch.prepareForQuit();
  });

  it("释放时序：并行事实的释放先于 end 事件 publish（T8.3b 验收 §5 缺口补钉）", async () => {
    // 渲染层以 end 事件为「重取 sessions:active-turns」的触发器：若释放晚于 publish
    //（如留在 drain 的 finally），重取会拿到含死轮的快照且再无后续触发器纠正。
    // 常规用例经 await flush 只能观察终态，钉不住这个窗口——故在注入的 publish
    // 回调里同步查表：end 到达的瞬间该轮必须已不在登记表。
    // 反向自证：把 finalize 入口的 releaseParallelFacts 挪回 publish 之后，本用例即红。
    const controllers: ScriptController[] = [];
    const h = makeHarness([], { adapter: scriptableAdapter(controllers), task: TASK_APP });
    const inflightAtEndPublish: (readonly string[])[] = [];
    let orchRef: ReturnType<typeof createSessionOrchestrator> | undefined;
    const deps: SessionOrchestratorDeps = {
      ...h.deps,
      publish: (e) => {
        h.published.push(e);
        if (e.kind === "end") {
          inflightAtEndPublish.push((orchRef?.listActiveTurns("/proj") ?? []).map((r) => r.turnId));
        }
      },
    };
    const orch = createSessionOrchestrator(deps);
    orchRef = orch;

    const ack = await orch.start(workerReq("tA", "task-app"));
    expect(ack.accepted).toBe(true);
    const a = controllers[0];
    if (a === undefined) {
      throw new Error("tA 该已 startTurn");
    }
    a.push({ kind: "text", content: "ok", final: true, channel: "answer" });
    a.push({ kind: "end", reason: "completed" });
    a.close();
    await flush();

    // end 恰 publish 一次，且那一瞬间登记表已不含 tA（释放先于 publish）
    expect(inflightAtEndPublish).toEqual([[]]);
  });

  it("僵尸注销根治：cancel 后事件流悬挂 → 宽限期后并行事实强制释放，相交任务可派发（T8.3a 验收 §2-2）", async () => {
    const { orch } = parallelHarness([TASK_APP, TASK_SUB], { cancelEndsStream: false });

    await orch.start(workerReq("tA", "task-app"));
    expect(await orch.cancel({ turnId: "tA" })).toEqual({ ok: true });

    // 悬挂流不产生 end → drain 不完成；等 CANCEL_UNREGISTER_GRACE_MS 过后兜底注销
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, CANCEL_UNREGISTER_GRACE_MS + 100));
      expect(orch.listActiveTurns("/proj")).toEqual([]);
      // 句柄表如实保留（流理论上还能终结，届时 finally 的注销幂等）——只清裁决事实
      expect(orch.hasActiveTurn("tA")).toBe(true);

      const ack = await orch.start(workerReq("tB", "task-sub"));
      expect(ack.accepted).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("健康适配器 cancel 后即刻 end：注销走 drain 正常路径，不触发强制释放告警", async () => {
    const { orch } = parallelHarness([TASK_APP]);

    await orch.start(workerReq("tA", "task-app"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await orch.cancel({ turnId: "tA" });
      await new Promise((resolve) => setTimeout(resolve, CANCEL_UNREGISTER_GRACE_MS + 100));
      expect(orch.listActiveTurns("/proj")).toEqual([]);
      expect(orch.activeCount()).toBe(0);
      const forced = warn.mock.calls.filter((call) =>
        String(call[0]).includes("parallel facts released"),
      );
      expect(forced).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("权限请求并发：多轮同时 blocked 时按 turnId 路由，deny 只取消那一轮", async () => {
    const { h, orch, controllers } = parallelHarness([TASK_APP, TASK_LIB]);

    await orch.start(workerReq("tA", "task-app"));
    await orch.start(workerReq("tB", "task-lib"));
    const [a, b] = controllers;
    if (a === undefined || b === undefined) {
      throw new Error("两轮都该已 startTurn");
    }
    // 两轮各自越出自己的 writePaths（项目内）→ guard 各自合成 permission_request 上浮
    a.push({ kind: "file_change", path: "docs/a.md", changeKind: "update", status: "started" });
    b.push({ kind: "file_change", path: "docs/b.md", changeKind: "update", status: "started" });
    await flush();

    const requests = h.published.filter((e) => e.kind === "permission-request");
    expect(requests.map((e) => e.turnId).sort()).toEqual(["tA", "tB"]);
    const requestA = requests.find((e) => e.turnId === "tA");
    if (requestA === undefined || requestA.kind !== "permission-request") {
      throw new Error("tA 的权限请求该已上浮");
    }

    // 只 deny A：guard 的 cancelOnDeny 取消 A 那一轮；B 不受牵连、其待批仍挂着
    expect(
      await orch.respondPermission({
        turnId: "tA",
        requestId: requestA.requestId,
        decision: "deny",
      }),
    ).toEqual({ ok: true });
    await flush();

    expect(orch.activeCount()).toBe(1);
    expect(orch.listActiveTurns("/proj").map((r) => r.turnId)).toEqual(["tB"]);
    // B 照常收尾
    b.push({ kind: "text", content: "B done", final: true, channel: "answer" });
    b.push({ kind: "end", reason: "completed" });
    b.close();
    await flush();
    expect(orch.activeCount()).toBe(0);
  });

  it("互斥只在同项目内：别的项目的相交 writeScope 不挡派发；同项目根的写法差异（大小写/分隔符）仍互斥", async () => {
    const { orch } = parallelHarness([TASK_APP, TASK_SUB]);

    await orch.start(workerReq("tA", "task-app", "/proj"));
    // 别的项目：writePaths 是相对项目根的模式，跨项目同名路径不是同一批文件
    const other = await orch.start(workerReq("tOther", "task-sub", "/other"));
    expect(other.accepted).toBe(true);
    // 同一项目根的另一种写法（Windows 现实）：仍是同一项目，照拒
    const samePath = await orch.start(workerReq("tSame", "task-sub", "\\PROJ"));
    expect(samePath.accepted).toBe(false);

    await orch.prepareForQuit();
  });
});

describe("T8.4 自定义角色轮次", () => {
  const CUSTOM_ROLE_ID = "role-a1b2c3d4e5f6";
  const CUSTOM_ROLE = {
    id: CUSTOM_ROLE_ID,
    name: "文档撰写者",
    systemPrompt: "你是文档撰写者。只改 docs/ 下的文档，不碰源码。",
    permissionPreset: {
      readPaths: ["**"],
      writePaths: ["docs/**"],
      shell: "forbidden",
      network: false,
      dangerousOpsRequireApproval: true as const,
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const DONE_EVENTS: AgentEvent[] = [
    { kind: "session_start" },
    { kind: "text", content: "done", final: true, channel: "answer" },
    { kind: "end", reason: "completed" },
  ];

  /** 绑定自定义角色的 Profile（预设与角色预设同形）。 */
  function customProfile(): AgentProfile {
    return profile({
      defaultRole: CUSTOM_ROLE_ID,
      permissionPreset: CUSTOM_ROLE.permissionPreset,
    });
  }

  function withCustomRole(h: Harness): SessionOrchestratorDeps {
    return {
      ...h.deps,
      loadCustomRole: async (id) =>
        (id as string) === CUSTOM_ROLE_ID
          ? (CUSTOM_ROLE as unknown as Awaited<
              ReturnType<NonNullable<SessionOrchestratorDeps["loadCustomRole"]>>
            >)
          : undefined,
    };
  }

  it("讨论轮按自定义角色行事：第 1 层为 systemPrompt 原文、事件与登记 role 均为角色 ID、信封为角色预设 ∩ Profile 预设", async () => {
    const h = makeHarness(DONE_EVENTS, { profile: customProfile() });
    const orch = createSessionOrchestrator(withCustomRole(h));

    const ack = await orch.start(plannerRequest());
    expect(ack.accepted).toBe(true);
    // 在飞表登记：role 为角色 ID，writePaths 为交集后的 docs 子树（forbidden shell 不影响写范围）
    expect(orch.listActiveTurns("/proj")[0]).toMatchObject({
      role: CUSTOM_ROLE_ID,
      writePaths: ["docs"],
    });
    await flushUntilEnd(h.published);

    // started 事件与会话登记的 role 都是自定义角色 ID（RoleRef 联合）
    expect(h.published[0]).toMatchObject({ kind: "started", role: CUSTOM_ROLE_ID });
    expect(h.savedSessions[0]?.role).toBe(CUSTOM_ROLE_ID);
    // Prompt 第 1 层是角色提示词原文，不是内置 planner 定义
    const prompt = h.captured[0]?.prompt ?? "";
    expect(prompt).toContain("# 角色\n你是文档撰写者。只改 docs/ 下的文档，不碰源码。");
    expect(prompt).not.toContain("你是规划者");
    // turn_end 的 role 同样是角色 ID（transcript 落盘）
    const turnEnd = [...h.transcripts.values()][0]?.find((e) => e.kind === "turn_end");
    expect(turnEnd).toMatchObject({ role: CUSTOM_ROLE_ID });
  });

  it("自定义角色不存在（被删 / 宿主未接）：受理拒绝并给出原因，不 spawn", async () => {
    const h = makeHarness(DONE_EVENTS, { profile: customProfile() });
    // 宿主接了 loadCustomRole 但查无此角色
    const orch = createSessionOrchestrator({
      ...h.deps,
      loadCustomRole: async () => undefined,
    });
    const ack = await orch.start(plannerRequest());
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) {
      expect(ack.reason).toContain("自定义角色不存在");
    }
    expect(h.captured).toHaveLength(0);

    // 宿主完全未注入 loadCustomRole：同样拒绝
    const h2 = makeHarness(DONE_EVENTS, { profile: customProfile() });
    const orch2 = createSessionOrchestrator(h2.deps);
    const ack2 = await orch2.start(plannerRequest());
    expect(ack2.accepted).toBe(false);
  });

  it("计划生成轮恒按 planner 执行：自定义角色 Profile 发起 planner-plan 时第 1 层仍是内置 planner", async () => {
    const h = makeHarness(DONE_EVENTS, { profile: customProfile() });
    const orch = createSessionOrchestrator(withCustomRole(h));
    const ack = await orch.start({
      turnId: "t-plan",
      projectRoot: "/proj",
      profileId: "prof-1" as unknown as ProfileId,
      input: { kind: "planner-plan" },
    });
    expect(ack.accepted).toBe(true);
    await flushUntilEnd(h.published);
    expect(h.published[0]).toMatchObject({ kind: "started", role: "planner" });
    const prompt = h.captured[0]?.prompt ?? "";
    expect(prompt).toContain("你是规划者");
    expect(prompt).not.toContain("文档撰写者");
  });

  it("内置角色行为逐字不变：planner Profile 的讨论轮不受 loadCustomRole 注入影响", async () => {
    const h = makeHarness(DONE_EVENTS, { profile: profile({ defaultRole: "planner" }) });
    const orch = createSessionOrchestrator(withCustomRole(h));
    await orch.start(plannerRequest());
    await flushUntilEnd(h.published);
    expect(h.published[0]).toMatchObject({ kind: "started", role: "planner" });
    expect(h.captured[0]?.prompt ?? "").toContain("你是规划者");
  });

  it("信封交集生效：自定义角色 shell=forbidden 时轮内命令判违规、整轮被掐断（§7 公式同款）", async () => {
    // 事件流里发一条命令：guardTurn 依交集后的信封裁决，forbidden 策略下判 violation，
    // 事前拦截取消整轮——与审查轮"合同外命令掐断整轮"同一机制。
    const events: AgentEvent[] = [
      { kind: "session_start" },
      { kind: "command", command: "npm run build", status: "completed", exitCode: 0 },
      { kind: "text", content: "done", final: true, channel: "answer" },
      { kind: "end", reason: "completed" },
    ];
    const h = makeHarness(events, { profile: customProfile() });
    const orch = createSessionOrchestrator(withCustomRole(h));
    await orch.start(plannerRequest());
    await flushUntilEnd(h.published);
    expect(h.published.at(-1)).not.toMatchObject({ reason: "completed" });
  });
});
