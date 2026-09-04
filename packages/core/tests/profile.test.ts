/**
 * W1.6 core 侧单测：Agent Profile 草稿校验（设计文档 §4.4 / §3.1）。
 * 覆盖：校验矩阵（Provider 不存在 / 模型 kind 错 / 预设越权 / 合法通过）、
 * 判别联合结果与字段名、依赖注入（同步 / 异步 getProvider）、
 * "预设 ∩ 角色默认 = 预设"的规范化比较（等价形态不误报）。
 */

import type {
  AiOutputLanguage,
  ApiKeyRef,
  CustomRole,
  CustomRoleId,
  GenericExecProfileConfig,
  PermissionEnvelope,
  Provider,
  ProviderId,
  Role,
  ShellPolicy,
} from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  PLANNER_DEFAULT_ENVELOPE,
  type ProfileDraft,
  ProfileValidationError,
  type ProfileValidationResult,
  REVIEWER_DEFAULT_ENVELOPE,
  validateProfileDraft,
} from "../src/index.js";

const CHAT_PROVIDER: Provider = {
  id: "provider-3f2a9c1d8e4b" as ProviderId,
  name: "我的 DeepSeek",
  type: "openai_compatible",
  baseUrl: "https://api.deepseek.com/v1",
  apiKeyRef: "keyref-deepseek-001" as ApiKeyRef,
  models: [
    { id: "deepseek-chat", displayName: "DeepSeek Chat", kind: "chat" },
    { id: "text-embedding-v1", displayName: "嵌入模型", kind: "embedding" },
  ],
  defaultModel: "deepseek-chat",
  enabled: true,
};

/** 未配置 defaultModel 的 Provider（cli_login 允许 models 为空）。 */
const NO_DEFAULT_PROVIDER: Provider = {
  id: "provider-9b8c7d6e5f4a" as ProviderId,
  name: "Claude 订阅登录",
  type: "cli_login",
  models: [],
  enabled: true,
};

/** 同步 getProvider：与 W1.5a 约定一致，不存在返回 undefined 不抛错。 */
const DEPS = {
  getProvider: (id: ProviderId): Provider | undefined =>
    [CHAT_PROVIDER, NO_DEFAULT_PROVIDER].find((provider) => provider.id === id),
};

const WORKER_PRESET: PermissionEnvelope = {
  readPaths: ["**"],
  writePaths: ["src/**"],
  shell: "allowed",
  network: false,
  dangerousOpsRequireApproval: true,
};

function workerDraft(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
  return {
    name: "Claude 执行者",
    runtime: "claude-code",
    providerId: CHAT_PROVIDER.id,
    model: "deepseek-chat",
    defaultRole: "worker",
    permissionPreset: WORKER_PRESET,
    outputLanguage: "zh-CN",
    ...overrides,
  };
}

function plannerDraft(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
  return {
    name: "DeepSeek 规划",
    runtime: "opencode",
    providerId: CHAT_PROVIDER.id,
    defaultRole: "planner",
    permissionPreset: PLANNER_DEFAULT_ENVELOPE,
    ...overrides,
  };
}

/** 断言校验失败且违规字段名（含顺序）完全匹配。 */
function expectViolationFields(result: ProfileValidationResult, fields: readonly string[]): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.violations.map((violation) => violation.field)).toEqual(fields);
  for (const violation of result.violations) {
    expect(violation.reason.length).toBeGreaterThan(0);
  }
}

describe("合法 Profile 通过（§4.4 示例矩阵）", () => {
  it("Worker：指定 chat 模型 + 预设窄于角色默认 + 指定输出语言", async () => {
    expect(await validateProfileDraft(workerDraft(), DEPS)).toEqual({ ok: true });
  });

  it("Planner：model 缺省（Provider 已配置 defaultModel）+ 角色默认预设 + 输出语言跟随全局", async () => {
    expect(await validateProfileDraft(plannerDraft(), DEPS)).toEqual({ ok: true });
  });

  it("Reviewer：角色默认预设通过", async () => {
    const draft = workerDraft({
      defaultRole: "reviewer",
      permissionPreset: REVIEWER_DEFAULT_ENVELOPE,
    });
    expect(await validateProfileDraft(draft, DEPS)).toEqual({ ok: true });
  });

  it("预设严格窄于角色默认同样通过（只禁宽于，不禁窄于）", async () => {
    const draft = workerDraft({
      permissionPreset: {
        readPaths: ["src"],
        writePaths: ["src/generated"],
        shell: "verify_only",
        network: false,
        dangerousOpsRequireApproval: true,
      },
    });
    expect(await validateProfileDraft(draft, DEPS)).toEqual({ ok: true });
  });

  it("作用域列表的等价形态不误报：冗余条目与尾部 /** 在比较前规范化", async () => {
    const draft = workerDraft({
      permissionPreset: {
        ...WORKER_PRESET,
        // "src/sub" 被 "src/**" 覆盖属冗余；两种写法均等价于子树 "src"
        writePaths: ["src/**", "src/sub"],
      },
    });
    expect(await validateProfileDraft(draft, DEPS)).toEqual({ ok: true });
  });

  it("异步 getProvider（W1.5a ProviderStore 的实际签名）同样生效", async () => {
    const asyncDeps = {
      getProvider: async (id: ProviderId): Promise<Provider | undefined> =>
        id === CHAT_PROVIDER.id ? CHAT_PROVIDER : undefined,
    };
    expect(await validateProfileDraft(workerDraft(), asyncDeps)).toEqual({ ok: true });
    expectViolationFields(
      await validateProfileDraft(
        workerDraft({ providerId: "provider-000000000000" as ProviderId }),
        asyncDeps,
      ),
      ["providerId"],
    );
  });
});

describe("Provider 与模型（§4.4：Provider + 模型）", () => {
  it("Provider 不存在：providerId 违规，且模型检查跳过（不叠报）", async () => {
    const draft = workerDraft({
      providerId: "provider-ffffffffffff" as ProviderId,
      model: "不存在的模型",
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["providerId"]);
  });

  it("指定 model 不在 Provider 的 models 中：model 违规", async () => {
    const draft = workerDraft({ model: "gpt-99" });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["model"]);
  });

  it("指定 model 的 kind 是 embedding 而非 chat：model 违规", async () => {
    const draft = workerDraft({ model: "text-embedding-v1" });
    const result = await validateProfileDraft(draft, DEPS);
    expectViolationFields(result, ["model"]);
    if (!result.ok) {
      expect(result.violations[0]?.reason).toContain("chat");
    }
  });

  it("model 缺省但 Provider 未配置 defaultModel：model 违规", async () => {
    const { model: _model, ...withoutModel } = workerDraft();
    const draft: ProfileDraft = { ...withoutModel, providerId: NO_DEFAULT_PROVIDER.id };
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["model"]);
  });
});

describe("角色与输出语言（§3.1 / §9.2）", () => {
  it("defaultRole 非法（JSON / IPC 边界防线）：defaultRole 违规，预设合规检查跳过", async () => {
    // 预设故意全宽：角色非法时无从取角色默认信封，只应报 defaultRole 一条
    const draft = workerDraft({
      defaultRole: "architect" as Role,
      permissionPreset: {
        readPaths: ["**"],
        writePaths: ["**"],
        shell: "allowed",
        network: true,
        dangerousOpsRequireApproval: true,
      },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["defaultRole"]);
  });

  it("outputLanguage 非法值拒绝；缺省（跟随全局）与合法值通过", async () => {
    const invalid = workerDraft({ outputLanguage: "fr-FR" as AiOutputLanguage });
    expectViolationFields(await validateProfileDraft(invalid, DEPS), ["outputLanguage"]);

    const { outputLanguage: _outputLanguage, ...omitted } = workerDraft();
    expect(await validateProfileDraft(omitted, DEPS)).toEqual({ ok: true });
    expect(await validateProfileDraft(workerDraft({ outputLanguage: "en-US" }), DEPS)).toEqual({
      ok: true,
    });
  });
});

describe("权限预设合规：预设 ∩ 角色默认 = 预设（W1.1 非法组合规则）", () => {
  it("典型违规：Planner 预设含写路径", async () => {
    const draft = plannerDraft({
      permissionPreset: { ...PLANNER_DEFAULT_ENVELOPE, writePaths: ["src"] },
    });
    const result = await validateProfileDraft(draft, DEPS);
    expectViolationFields(result, ["permissionPreset.writePaths"]);
    if (!result.ok) {
      expect(result.violations[0]?.reason).toContain("planner");
    }
  });

  it("Planner 预设 shell 为 allowed（角色默认 forbidden）：shell 违规", async () => {
    const draft = plannerDraft({
      permissionPreset: { ...PLANNER_DEFAULT_ENVELOPE, shell: "allowed" },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["permissionPreset.shell"]);
  });

  it("Reviewer 预设 shell 为 allowed（角色默认 verify_only）：shell 违规", async () => {
    const draft = workerDraft({
      defaultRole: "reviewer",
      permissionPreset: { ...REVIEWER_DEFAULT_ENVELOPE, shell: "allowed" },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["permissionPreset.shell"]);
  });

  it("Worker 预设开网络（角色默认禁止）：network 违规", async () => {
    const draft = workerDraft({
      permissionPreset: { ...WORKER_PRESET, network: true },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["permissionPreset.network"]);
  });

  it("shell 字面量非法（JSON / IPC 边界防线）：shell 违规，交集计算跳过", async () => {
    const draft = workerDraft({
      permissionPreset: { ...WORKER_PRESET, shell: "sudo" as ShellPolicy },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["permissionPreset.shell"]);
  });

  it("危险操作确认被关闭（JSON / IPC 边界防线）：违规", async () => {
    const draft = workerDraft({
      permissionPreset: {
        ...WORKER_PRESET,
        dangerousOpsRequireApproval: false as unknown as true,
      },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), [
      "permissionPreset.dangerousOpsRequireApproval",
    ]);
  });

  it("多处违规一次全部收集（判别联合，不快速失败）", async () => {
    const draft = plannerDraft({
      outputLanguage: "eo" as AiOutputLanguage,
      permissionPreset: {
        ...PLANNER_DEFAULT_ENVELOPE,
        writePaths: ["src"],
        shell: "allowed",
      },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), [
      "outputLanguage",
      "permissionPreset.writePaths",
      "permissionPreset.shell",
    ]);
  });
});

describe("自定义角色 defaultRole（T8.4）", () => {
  const CUSTOM_ROLE: CustomRole = {
    id: "role-a1b2c3d4e5f6" as CustomRoleId,
    name: "文档撰写者",
    systemPrompt: "你是文档撰写者。",
    permissionPreset: {
      readPaths: ["**"],
      writePaths: ["docs/**"],
      shell: "forbidden",
      network: false,
      dangerousOpsRequireApproval: true,
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const DEPS_WITH_ROLES = {
    ...DEPS,
    getCustomRole: (id: CustomRoleId): CustomRole | undefined =>
      id === CUSTOM_ROLE.id ? CUSTOM_ROLE : undefined,
  };

  it("defaultRole 为已存在的自定义角色 ID 且预设 ⊆ 角色预设：通过", async () => {
    const draft = workerDraft({
      defaultRole: CUSTOM_ROLE.id,
      permissionPreset: {
        readPaths: ["**"],
        writePaths: ["docs/guide"],
        shell: "forbidden",
        network: false,
        dangerousOpsRequireApproval: true,
      },
    });
    expect(await validateProfileDraft(draft, DEPS_WITH_ROLES)).toEqual({ ok: true });
  });

  it("预设宽于自定义角色的预设（角色默认层）：违规", async () => {
    const draft = workerDraft({
      defaultRole: CUSTOM_ROLE.id,
      permissionPreset: {
        readPaths: ["**"],
        writePaths: ["src/**"], // 角色只许写 docs/**
        shell: "allowed", // 角色 shell 为 forbidden
        network: false,
        dangerousOpsRequireApproval: true,
      },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS_WITH_ROLES), [
      "permissionPreset.writePaths",
      "permissionPreset.shell",
    ]);
  });

  it("自定义角色 ID 不存在：defaultRole 违规，预设合规检查跳过", async () => {
    const draft = workerDraft({ defaultRole: "role-000000000000" as CustomRoleId });
    expectViolationFields(await validateProfileDraft(draft, DEPS_WITH_ROLES), ["defaultRole"]);
  });

  it("宿主未注入 getCustomRole：一切 CustomRoleId 视为不存在", async () => {
    const draft = workerDraft({ defaultRole: CUSTOM_ROLE.id });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["defaultRole"]);
  });

  it("异步 getCustomRole（RoleStore 的实际签名）同样生效", async () => {
    const asyncDeps = {
      ...DEPS,
      getCustomRole: async (id: CustomRoleId): Promise<CustomRole | undefined> =>
        id === CUSTOM_ROLE.id ? CUSTOM_ROLE : undefined,
    };
    const draft = workerDraft({
      defaultRole: CUSTOM_ROLE.id,
      permissionPreset: CUSTOM_ROLE.permissionPreset,
    });
    expect(await validateProfileDraft(draft, asyncDeps)).toEqual({ ok: true });
  });
});

describe("generic-exec 命令配置（T8.4b 多实例装配）", () => {
  const GX = {
    command: "mytool",
    args: ["--run", "{task}"],
    taskDelivery: "argv",
  } as const satisfies GenericExecProfileConfig;

  it("generic-exec Profile 带合法配置（argv + 占位符）：通过", async () => {
    const draft = workerDraft({ runtime: "generic-exec", genericExec: GX });
    expect(await validateProfileDraft(draft, DEPS)).toEqual({ ok: true });
  });

  it("stdin 模式（args 无占位符）同样通过", async () => {
    const draft = workerDraft({
      runtime: "generic-exec",
      genericExec: { command: "mytool", args: ["--quiet"], taskDelivery: "stdin" },
    });
    expect(await validateProfileDraft(draft, DEPS)).toEqual({ ok: true });
  });

  it("generic-exec Profile 缺配置：genericExec 违规（实例化无米下锅）", async () => {
    const draft = workerDraft({ runtime: "generic-exec" });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["genericExec"]);
  });

  it("非 generic-exec Profile 带配置：genericExec 违规（脏数据拒收）", async () => {
    const draft = workerDraft({ genericExec: GX });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["genericExec"]);
  });

  it("命令为空 / 命令含 {task}：genericExec.command 违规", async () => {
    expectViolationFields(
      await validateProfileDraft(
        workerDraft({ runtime: "generic-exec", genericExec: { ...GX, command: "  " } }),
        DEPS,
      ),
      ["genericExec.command"],
    );
    expectViolationFields(
      await validateProfileDraft(
        workerDraft({ runtime: "generic-exec", genericExec: { ...GX, command: "run-{task}" } }),
        DEPS,
      ),
      ["genericExec.command"],
    );
  });

  it("argv 模式无占位符：genericExec.args 违规（任务文本无处可去）", async () => {
    const draft = workerDraft({
      runtime: "generic-exec",
      genericExec: { command: "mytool", args: ["--run"], taskDelivery: "argv" },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["genericExec.args"]);
  });

  it("stdin 模式残留占位符：genericExec.args 违规（两处投递会重复）", async () => {
    const draft = workerDraft({
      runtime: "generic-exec",
      genericExec: { command: "mytool", args: ["{task}"], taskDelivery: "stdin" },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["genericExec.args"]);
  });

  it("投递方式非法（JSON / IPC 边界防线）：genericExec.taskDelivery 违规，占位符检查跳过", async () => {
    const draft = workerDraft({
      runtime: "generic-exec",
      genericExec: {
        command: "mytool",
        args: [],
        taskDelivery: "clipboard" as GenericExecProfileConfig["taskDelivery"],
      },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), ["genericExec.taskDelivery"]);
  });

  it("配置违规与其他违规一次全部收集", async () => {
    const draft = workerDraft({
      runtime: "generic-exec",
      model: "gpt-99",
      genericExec: { command: "", args: [], taskDelivery: "argv" },
    });
    expectViolationFields(await validateProfileDraft(draft, DEPS), [
      "model",
      "genericExec.command",
      "genericExec.args",
    ]);
  });
});

describe("ProfileValidationError（抛错通道封装，供 storage 校验回调接线）", () => {
  it("携带全部违规，message 含字段名", async () => {
    const draft = plannerDraft({
      permissionPreset: { ...PLANNER_DEFAULT_ENVELOPE, writePaths: ["src"], shell: "allowed" },
    });
    const result = await validateProfileDraft(draft, DEPS);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const error = new ProfileValidationError(result.violations);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ProfileValidationError");
    expect(error.violations).toEqual(result.violations);
    expect(error.message).toContain("permissionPreset.writePaths");
    expect(error.message).toContain("permissionPreset.shell");
    expect(error.message).toContain("2 处违规");
  });
});
