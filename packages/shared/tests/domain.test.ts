import { describe, expect, it } from "vitest";
import type {
  AgentProfile,
  ApiKeyRef,
  Handoff,
  KnowledgeChunkId,
  KnowledgeEntryId,
  KnowledgeHit,
  LocalSessionId,
  MemoryEntry,
  MemoryEntryId,
  MemorySource,
  NativeSessionBinding,
  NativeSessionId,
  PermissionEnvelope,
  PermissionRequest,
  PermissionRequestId,
  Plan,
  PlanVersion,
  ProfileId,
  Project,
  ProjectId,
  Provider,
  ProviderId,
  Run,
  RunId,
  SessionRecord,
  Task,
  TaskContract,
  TaskId,
} from "../src/index.js";
import {
  AI_OUTPUT_LANGUAGES,
  CLARIFICATION_ANSWERED_BY,
  createLiteralGuard,
  DANGEROUS_OPERATIONS,
  FALLBACK_UI_LANGUAGE,
  HABIT_CATEGORIES,
  HABIT_ENTRY_SOFT_LIMIT,
  HABIT_SOURCE_KINDS,
  isAiOutputLanguage,
  isClarificationAnsweredBy,
  isDangerousOperation,
  isHabitCategory,
  isHabitSourceKind,
  isKnowledgeFormat,
  isKnowledgeOriginKind,
  isMemoryCategory,
  isMemoryConfidence,
  isMemorySourceKind,
  isMemoryStatus,
  isModelKind,
  isPermissionRequestKind,
  isPlanStatus,
  isProviderType,
  isRole,
  isRunEndReason,
  isSessionResumeKind,
  isShellPolicy,
  isTaskStatus,
  isTaskTerminalStatus,
  isUiLanguage,
  isUiLanguageSetting,
  KNOWLEDGE_FORMATS,
  KNOWLEDGE_ORIGIN_KINDS,
  MEMORY_CATEGORIES,
  MEMORY_CONFIDENCES,
  MEMORY_INJECTION_DEFAULT_LIMIT,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MODEL_KINDS,
  PERMISSION_REQUEST_KINDS,
  PLAN_STATUSES,
  PROVIDER_DEFAULT_TIMEOUT_S,
  PROVIDER_TYPES,
  ROLES,
  RUN_END_REASONS,
  SESSION_RESUME_KINDS,
  SHELL_POLICIES,
  TASK_STATUSES,
  TASK_TERMINAL_STATUSES,
  UI_LANGUAGE_SETTINGS,
  UI_LANGUAGES,
} from "../src/index.js";

/** 全部字面量常量数组（用于共性检查：非空、无重复、守卫一致性）。 */
const ALL_LITERAL_ARRAYS: ReadonlyArray<readonly string[]> = [
  AI_OUTPUT_LANGUAGES,
  CLARIFICATION_ANSWERED_BY,
  DANGEROUS_OPERATIONS,
  HABIT_CATEGORIES,
  HABIT_SOURCE_KINDS,
  KNOWLEDGE_FORMATS,
  KNOWLEDGE_ORIGIN_KINDS,
  MEMORY_CATEGORIES,
  MEMORY_CONFIDENCES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MODEL_KINDS,
  PERMISSION_REQUEST_KINDS,
  PLAN_STATUSES,
  PROVIDER_TYPES,
  ROLES,
  RUN_END_REASONS,
  SESSION_RESUME_KINDS,
  SHELL_POLICIES,
  TASK_STATUSES,
  TASK_TERMINAL_STATUSES,
  UI_LANGUAGE_SETTINGS,
  UI_LANGUAGES,
];

describe("常量数组 ↔ 设计文档定值对照", () => {
  it("§4.2 Provider 四类型", () => {
    expect(PROVIDER_TYPES).toEqual(["openai_compatible", "anthropic", "cli_login", "custom"]);
  });

  it("§4.1 模型条目 kind：chat | embedding", () => {
    expect(MODEL_KINDS).toEqual(["chat", "embedding"]);
  });

  it("§4.1 timeout_s 缺省 120 秒", () => {
    expect(PROVIDER_DEFAULT_TIMEOUT_S).toBe(120);
  });

  it("§3.1 角色三个，不再多", () => {
    expect(ROLES).toEqual(["planner", "worker", "reviewer"]);
  });

  it("§6.1 计划 5 状态", () => {
    expect(PLAN_STATUSES).toEqual(["draft", "approved", "superseded", "completed", "cancelled"]);
  });

  it("§6.3 任务状态（正文枚举 7 个字面量，含 cancelled 终态）", () => {
    expect(TASK_STATUSES).toEqual([
      "pending",
      "running",
      "blocked",
      "failed",
      "done",
      "accepted",
      "cancelled",
    ]);
  });

  it("§6.3 终态为 accepted 与 cancelled，且是任务状态子集", () => {
    expect(TASK_TERMINAL_STATUSES).toEqual(["accepted", "cancelled"]);
    for (const status of TASK_TERMINAL_STATUSES) {
      expect(TASK_STATUSES).toContain(status);
    }
  });

  it("§6.5 澄清请求回答方：用户或 Planner", () => {
    expect(CLARIFICATION_ANSWERED_BY).toEqual(["user", "planner"]);
  });

  it("§6.4 Run 结束原因 4 种", () => {
    expect(RUN_END_REASONS).toEqual(["completed", "failed", "cancelled", "crashed"]);
  });

  it("§7 Shell 命令三档策略", () => {
    expect(SHELL_POLICIES).toEqual(["forbidden", "allowed", "verify_only"]);
  });

  it("§7 危险操作固定清单恰好 6 项", () => {
    expect(DANGEROUS_OPERATIONS).toEqual([
      "delete_outside_write_scope",
      "git_push",
      "modify_git_dir",
      "read_credential_paths",
      "install_system_software",
      "publish_or_deploy",
    ]);
  });

  it("§7 权限扩展请求类别与信封 5 项对应", () => {
    expect(PERMISSION_REQUEST_KINDS).toEqual([
      "read_path",
      "write_path",
      "shell_command",
      "network",
      "dangerous_operation",
    ]);
  });

  it("§8.1 项目记忆 4 类 / 3 状态 / 2 档置信度 / 4 种来源", () => {
    expect(MEMORY_CATEGORIES).toEqual(["decision", "rule", "lesson", "state"]);
    expect(MEMORY_STATUSES).toEqual(["candidate", "active", "archived"]);
    expect(MEMORY_CONFIDENCES).toEqual(["high", "low"]);
    expect(MEMORY_SOURCE_KINDS).toEqual(["user_manual", "task", "plan", "agent_proposed"]);
  });

  it("§8.1 注入上限缺省 20 条；§8.2.5 习惯上限缺省 80 条", () => {
    expect(MEMORY_INJECTION_DEFAULT_LIMIT).toBe(20);
    expect(HABIT_ENTRY_SOFT_LIMIT).toBe(80);
  });

  it("§8.2 习惯 4 类与三种来源", () => {
    expect(HABIT_CATEGORIES).toEqual(["workflow", "tech", "communication", "environment"]);
    expect(HABIT_SOURCE_KINDS).toEqual(["user_manual", "distilled", "observed"]);
  });

  it("§8.3.2 知识库支持 6 种格式与 3 种导入方式", () => {
    expect(KNOWLEDGE_FORMATS).toEqual(["markdown", "text", "source_code", "pdf", "docx", "html"]);
    expect(KNOWLEDGE_ORIGIN_KINDS).toEqual(["file_import", "session_capture", "manual"]);
  });

  it("§9.1 界面语言首发 zh-CN / en-US，回退 zh-CN，设置可跟随系统", () => {
    expect(UI_LANGUAGES).toEqual(["zh-CN", "en-US"]);
    expect(UI_LANGUAGES).toContain(FALLBACK_UI_LANGUAGE);
    // 2026-09-01 经用户确认：中文为默认语言，解析级联的最后一环落 zh-CN
    expect(FALLBACK_UI_LANGUAGE).toBe("zh-CN");
    expect(UI_LANGUAGE_SETTINGS).toEqual(["system", "zh-CN", "en-US"]);
  });

  it("§9.2 AI 输出语言首发集合", () => {
    expect(AI_OUTPUT_LANGUAGES).toEqual(["zh-CN", "en-US"]);
  });

  it("§10.3 会话恢复三分法", () => {
    expect(SESSION_RESUME_KINDS).toEqual(["native", "context_rebuild", "handoff"]);
  });

  it("全部常量数组非空且无重复", () => {
    for (const values of ALL_LITERAL_ARRAYS) {
      expect(values.length).toBeGreaterThan(0);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});

describe("类型守卫行为", () => {
  const NON_MEMBERS: readonly unknown[] = [
    "",
    "nope",
    "PENDING",
    "Pending",
    42,
    0,
    null,
    undefined,
    {},
    [],
    true,
    Symbol("pending"),
  ];

  const guardCases: ReadonlyArray<{
    name: string;
    guard: (value: unknown) => boolean;
    values: readonly string[];
  }> = [
    { name: "isProviderType", guard: isProviderType, values: PROVIDER_TYPES },
    { name: "isModelKind", guard: isModelKind, values: MODEL_KINDS },
    { name: "isRole", guard: isRole, values: ROLES },
    { name: "isPlanStatus", guard: isPlanStatus, values: PLAN_STATUSES },
    { name: "isTaskStatus", guard: isTaskStatus, values: TASK_STATUSES },
    { name: "isTaskTerminalStatus", guard: isTaskTerminalStatus, values: TASK_TERMINAL_STATUSES },
    {
      name: "isClarificationAnsweredBy",
      guard: isClarificationAnsweredBy,
      values: CLARIFICATION_ANSWERED_BY,
    },
    { name: "isRunEndReason", guard: isRunEndReason, values: RUN_END_REASONS },
    { name: "isShellPolicy", guard: isShellPolicy, values: SHELL_POLICIES },
    { name: "isDangerousOperation", guard: isDangerousOperation, values: DANGEROUS_OPERATIONS },
    {
      name: "isPermissionRequestKind",
      guard: isPermissionRequestKind,
      values: PERMISSION_REQUEST_KINDS,
    },
    { name: "isMemoryCategory", guard: isMemoryCategory, values: MEMORY_CATEGORIES },
    { name: "isMemoryStatus", guard: isMemoryStatus, values: MEMORY_STATUSES },
    { name: "isMemoryConfidence", guard: isMemoryConfidence, values: MEMORY_CONFIDENCES },
    { name: "isMemorySourceKind", guard: isMemorySourceKind, values: MEMORY_SOURCE_KINDS },
    { name: "isHabitCategory", guard: isHabitCategory, values: HABIT_CATEGORIES },
    { name: "isHabitSourceKind", guard: isHabitSourceKind, values: HABIT_SOURCE_KINDS },
    { name: "isKnowledgeFormat", guard: isKnowledgeFormat, values: KNOWLEDGE_FORMATS },
    {
      name: "isKnowledgeOriginKind",
      guard: isKnowledgeOriginKind,
      values: KNOWLEDGE_ORIGIN_KINDS,
    },
    { name: "isUiLanguage", guard: isUiLanguage, values: UI_LANGUAGES },
    { name: "isUiLanguageSetting", guard: isUiLanguageSetting, values: UI_LANGUAGE_SETTINGS },
    { name: "isAiOutputLanguage", guard: isAiOutputLanguage, values: AI_OUTPUT_LANGUAGES },
    { name: "isSessionResumeKind", guard: isSessionResumeKind, values: SESSION_RESUME_KINDS },
  ];

  for (const { name, guard, values } of guardCases) {
    it(`${name} 接受全部合法字面量并拒绝其余输入`, () => {
      for (const value of values) {
        expect(guard(value), `${name}("${value}") 应为 true`).toBe(true);
      }
      for (const bad of NON_MEMBERS) {
        expect(guard(bad), `${name}(${String(bad)}) 应为 false`).toBe(false);
      }
    });
  }

  it("守卫用例覆盖了全部字面量常量数组", () => {
    // AI_OUTPUT_LANGUAGES 与 UI_LANGUAGES 内容相同但常量独立，逐一比对引用。
    const covered = new Set(guardCases.map((c) => c.values));
    for (const values of ALL_LITERAL_ARRAYS) {
      expect(covered.has(values), `常量数组 [${values.join(", ")}] 缺少守卫用例`).toBe(true);
    }
  });

  it("createLiteralGuard 生成的守卫在字符串子类型上工作", () => {
    const isAb = createLiteralGuard(["a", "b"] as const);
    expect(isAb("a")).toBe(true);
    expect(isAb("b")).toBe(true);
    expect(isAb("c")).toBe(false);
    expect(isAb(1)).toBe(false);
  });
});

describe("聚合结构冒烟（品牌 ID 断言 + 字段形态）", () => {
  const projectId = "prj-1" as ProjectId;
  const providerId = "prov-1" as ProviderId;
  const profileId = "prof-1" as ProfileId;
  const planVersion = 1 as PlanVersion;
  const taskId = "task-1" as TaskId;
  const runId = "run-1" as RunId;
  const memoryId = "mem-1" as MemoryEntryId;

  const envelope: PermissionEnvelope = {
    readPaths: ["**/*"],
    writePaths: [],
    shell: "forbidden",
    network: true,
    dangerousOpsRequireApproval: true,
  };

  const contract: TaskContract = {
    id: taskId,
    planVersion,
    goal: "给 shared 包补充 clamp 的边界测试",
    writeScope: ["packages/shared/tests/**"],
    forbidden: ["不得改动 src"],
    dependsOn: [],
    contextRefs: [memoryId],
    acceptance: ["pnpm test 全绿"],
    verifyCmd: "pnpm test",
  };

  const memoryEntry: MemoryEntry = {
    id: memoryId,
    category: "decision",
    title: "存储用 SQLite",
    body: "索引用 better-sqlite3 + FTS5，不引入外部服务。",
    status: "active",
    source: { kind: "user_manual" },
    confidence: "high",
    createdAt: 1_756_000_000_000,
    updatedAt: 1_756_000_000_000,
  };

  const plan: Plan = {
    version: planVersion,
    status: "approved",
    goal: "完成 shared 包测试补强",
    scope: ["补充边界测试"],
    nonGoals: ["不做重构"],
    constraints: ["禁止安装依赖"],
    decisions: ["测试框架沿用 Vitest"],
    tasks: [contract],
    acceptance: ["全部测试通过"],
    approvedBy: { by: "user", at: 1_756_000_000_000 },
  };

  it("Task = TaskContract + status，Task 可当作合同使用", () => {
    const task: Task = { ...contract, status: "pending" };
    const asContract: TaskContract = task;
    expect(asContract.id).toBe(taskId);
    expect(isTaskStatus(task.status)).toBe(true);
  });

  it("Plan 批准记录只能是用户", () => {
    expect(plan.approvedBy?.by).toBe("user");
    expect(plan.tasks[0]?.planVersion).toBe(planVersion);
  });

  it("Provider 只携带密钥引用，不含密钥本体字段", () => {
    const provider: Provider = {
      id: providerId,
      name: "我的 OpenRouter",
      type: "openai_compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyRef: "key-ref-1" as ApiKeyRef,
      models: [
        { id: "deepseek-chat", displayName: "DeepSeek Chat", kind: "chat" },
        { id: "text-embedding-3-small", displayName: "Embedding Small", kind: "embedding" },
      ],
      defaultModel: "deepseek-chat",
      embeddingModel: "text-embedding-3-small",
      enabled: true,
    };
    expect(Object.keys(provider)).not.toContain("apiKey");
    expect(provider.models.filter((m) => m.kind === "embedding")).toHaveLength(1);
  });

  it("AgentProfile 组装：Runtime + Provider + 模型 + 角色 + 权限 + 输出语言", () => {
    const profile: AgentProfile = {
      id: profileId,
      name: "DeepSeek 规划",
      runtime: "opencode",
      providerId,
      model: "deepseek-chat",
      defaultRole: "planner",
      permissionPreset: envelope,
      outputLanguage: "zh-CN",
    };
    expect(isRole(profile.defaultRole)).toBe(true);
    expect(profile.permissionPreset.dangerousOpsRequireApproval).toBe(true);
  });

  it("Project 角色绑定：planner/worker 必绑，reviewer 可选", () => {
    const project: Project = {
      id: projectId,
      name: "示例项目",
      rootPath: "D:/work/demo",
      roleBindings: { planner: profileId, worker: profileId },
      createdAt: 1_756_000_000_000,
    };
    expect(project.roleBindings.reviewer).toBeUndefined();
  });

  it("Run 证据字段齐备：文件修改 / 命令 / 验证结果", () => {
    const run: Run = {
      id: runId,
      taskId,
      attempt: 1,
      profileId,
      startedAt: 1_756_000_000_000,
      endedAt: 1_756_000_060_000,
      endReason: "completed",
      fileChanges: [{ path: "packages/shared/tests/clamp.test.ts", diff: "+it(...)" }],
      commands: [{ command: "pnpm test", exitCode: 0 }],
      verifyResult: { command: "pnpm test", exitCode: 0, output: "3 passed" },
      report: "已补充边界测试。",
      rawLogPath: ".workbench/runs/run-1/raw.log",
    };
    expect(run.verifyResult?.exitCode).toBe(0);
    expect(isRunEndReason(run.endReason ?? "")).toBe(true);
  });

  it("MemorySource 判别联合可窄化取出溯源字段", () => {
    const source: MemorySource = { kind: "task", taskId };
    expect(source.kind === "task" ? source.taskId : undefined).toBe(taskId);
    expect(memoryEntry.source.kind).toBe("user_manual");
  });

  it("PermissionRequest 危险操作载荷引用固定清单", () => {
    const request: PermissionRequest = {
      id: "perm-1" as PermissionRequestId,
      runId,
      taskId,
      payload: { kind: "dangerous_operation", operation: "git_push", detail: "git push origin" },
      requestedAt: 1_756_000_000_000,
    };
    expect(
      request.payload.kind === "dangerous_operation"
        ? isDangerousOperation(request.payload.operation)
        : false,
    ).toBe(true);
  });

  it("Handoff 恰好 8 个字段（§10.4 精简合同）", () => {
    const handoff: Handoff = {
      projectGoal: "完成 shared 包测试补强",
      plan,
      progress: [{ taskId, goal: contract.goal, status: "done" }],
      decisions: [memoryEntry],
      rules: [],
      recentLessons: [],
      openIssues: ["无"],
      expectation: "继续执行剩余任务",
    };
    expect(Object.keys(handoff)).toHaveLength(8);
  });

  it("SessionRecord 的原生会话绑定必须携带 cwd（T2.0：resume 绑定 cwd）", () => {
    const binding: NativeSessionBinding = {
      nativeSessionId: "9e228810-a71a-4268-88a7-d8b0b667b41f" as NativeSessionId,
      cwd: "D:/work/demo",
    };
    const session: SessionRecord = {
      id: "sess-1" as LocalSessionId,
      profileId,
      role: "planner",
      native: binding,
      resumeKind: "native",
      createdAt: 1_756_000_000_000,
      lastActiveAt: 1_756_000_060_000,
    };
    expect(session.native?.cwd).toBe("D:/work/demo");
    expect(isSessionResumeKind(session.resumeKind ?? "")).toBe(true);
  });

  it("知识库检索结果形态：命中块 + 前后相邻块 + 出处", () => {
    const entryId = "kb-1" as KnowledgeEntryId;
    const hit: KnowledgeHit = {
      chunk: {
        id: "chunk-2" as KnowledgeChunkId,
        entryId,
        seq: 2,
        text: "……命中正文……",
        provenance: { filePath: "docs/guide.md", headingPath: ["安装", "Windows"] },
      },
      score: 0.87,
      before: [
        {
          id: "chunk-1" as KnowledgeChunkId,
          entryId,
          seq: 1,
          text: "……前文……",
          provenance: { filePath: "docs/guide.md", headingPath: ["安装"] },
        },
      ],
      after: [],
    };
    expect(hit.chunk.provenance.filePath).toBe("docs/guide.md");
    expect(hit.before[0]?.seq).toBe(hit.chunk.seq - 1);
  });
});
