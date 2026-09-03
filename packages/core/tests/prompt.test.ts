/**
 * T4.1 Prompt 组装层单测：四层组装结构、记忆注入按角色选条 + 上限截断、
 * 输出语言三级级联。纯逻辑，无 IO。
 */

import type {
  AiOutputLanguageSettings,
  CustomRoleId,
  MemoryCategory,
  MemoryEntry,
  TaskContract,
} from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  assemblePrompt,
  DEFAULT_INJECTION_LIMIT,
  outputLanguageInstruction,
  ROLE_DEFINITIONS,
  resolveOutputLanguage,
  resolveRoleDefinition,
  selectMemoryForRole,
  truncateByPriority,
} from "../src/index.js";

function mem(overrides: Partial<Record<keyof MemoryEntry, unknown>>): MemoryEntry {
  return {
    id: "mem-x",
    category: "rule",
    title: "t",
    body: "b",
    status: "active",
    source: { kind: "user_manual" },
    confidence: "high",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as MemoryEntry;
}

function contract(overrides: Partial<Record<keyof TaskContract, unknown>>): TaskContract {
  return {
    id: "task-1",
    planVersion: 1,
    goal: "add a util",
    writeScope: ["src/**"],
    forbidden: ["no network"],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["tests pass"],
    ...overrides,
  } as unknown as TaskContract;
}

const LANG: AiOutputLanguageSettings = { global: "zh-CN" };

describe("resolveOutputLanguage（三级级联）", () => {
  it("仅全局", () => {
    expect(resolveOutputLanguage({ global: "zh-CN" })).toBe("zh-CN");
  });
  it("Profile 覆盖全局", () => {
    expect(resolveOutputLanguage({ global: "zh-CN", profile: "en-US" })).toBe("en-US");
  });
  it("项目覆盖 Profile 与全局（最高优先级）", () => {
    expect(resolveOutputLanguage({ global: "zh-CN", profile: "zh-CN", project: "en-US" })).toBe(
      "en-US",
    );
  });
  it("指令随语言变化", () => {
    expect(outputLanguageInstruction("zh-CN")).toContain("简体中文");
    expect(outputLanguageInstruction("en-US")).toContain("English");
  });
});

describe("selectMemoryForRole", () => {
  const memory = [
    mem({ id: "d1", category: "decision" }),
    mem({ id: "r1", category: "rule" }),
    mem({ id: "l1", category: "lesson" }),
    mem({ id: "arch", category: "decision", status: "candidate" }),
  ];

  it("Planner：active 的 decision + rule（排除 candidate / lesson）", () => {
    const ids = selectMemoryForRole("planner", memory).map((e) => e.id);
    expect(ids.sort()).toEqual(["d1", "r1"]);
  });
  it("Worker：仅任务 context_refs 指定条目", () => {
    const ids = selectMemoryForRole("worker", memory, contract({ contextRefs: ["l1"] })).map(
      (e) => e.id,
    );
    expect(ids).toEqual(["l1"]);
  });
  it("Reviewer：仅 rule", () => {
    expect(selectMemoryForRole("reviewer", memory).map((e) => e.id)).toEqual(["r1"]);
  });
  it("自定义角色（T8.4）：planner 同款 decision + rule（通用项目共识）", () => {
    const ids = selectMemoryForRole("role-abc123def456" as CustomRoleId, memory).map((e) => e.id);
    expect(ids.sort()).toEqual(["d1", "r1"]);
  });
});

describe("truncateByPriority", () => {
  it("按类别优先级（decision>rule>state>lesson）+ 更新时间截断", () => {
    const entries = [
      mem({ id: "a", category: "lesson", updatedAt: 100 }),
      mem({ id: "b", category: "decision", updatedAt: 1 }),
      mem({ id: "c", category: "rule", updatedAt: 50 }),
    ];
    expect(truncateByPriority(entries, 2).map((e) => e.id)).toEqual(["b", "c"]);
  });
  it("同类别按更新时间倒序", () => {
    const entries = [
      mem({ id: "old", category: "rule", updatedAt: 1 }),
      mem({ id: "new", category: "rule", updatedAt: 9 }),
    ];
    expect(truncateByPriority(entries, 5).map((e) => e.id)).toEqual(["new", "old"]);
  });
  it("DEFAULT_INJECTION_LIMIT 为 20", () => {
    expect(DEFAULT_INJECTION_LIMIT).toBe(20);
  });
});

describe("assemblePrompt（四层结构）", () => {
  it("含四层标题、角色说明、记忆、输入、语言指令", () => {
    const out = assemblePrompt({
      role: "worker",
      input: { kind: "task", contract: contract({ contextRefs: ["r1"] }) },
      projectMemory: [mem({ id: "r1", category: "rule", title: "用 vitest" })],
      outputLanguage: LANG,
    });
    expect(out).toContain("# 角色");
    expect(out).toContain("执行者（Worker）");
    expect(out).toContain("# 用户习惯");
    expect(out).toContain("# 项目记忆");
    expect(out).toContain("用 vitest");
    expect(out).toContain("# 当前输入");
    expect(out).toContain("任务目标：add a util");
    expect(out).toContain("可写范围");
    expect(out).toContain("简体中文");
  });

  it("M1 习惯档案留空位显示占位", () => {
    const out = assemblePrompt({
      role: "planner",
      input: { kind: "message", text: "帮我加个功能" },
      projectMemory: [],
      outputLanguage: LANG,
    });
    expect(out).toContain("# 用户习惯\n（暂无）");
    expect(out).toContain("帮我加个功能");
  });

  it("Planner 注入 state 快照", () => {
    const out = assemblePrompt({
      role: "planner",
      input: { kind: "message", text: "hi" },
      projectMemory: [],
      stateSnapshot: "已完成登录模块",
      outputLanguage: LANG,
    });
    expect(out).toContain("[state] 当前状态：已完成登录模块");
  });

  it("注入超上限被截断", () => {
    const many: MemoryEntry[] = Array.from({ length: 30 }, (_, i) =>
      mem({ id: `r${i}`, category: "rule" as MemoryCategory, updatedAt: i }),
    );
    const out = assemblePrompt({
      role: "planner",
      input: { kind: "message", text: "x" },
      projectMemory: many,
      outputLanguage: LANG,
      injectionLimit: 5,
    });
    const injected = out.split("\n").filter((l) => l.startsWith("- [rule]")).length;
    expect(injected).toBe(5);
  });
});

describe("自定义角色第 1 层（T8.4）", () => {
  const customId = "role-abc123def456" as CustomRoleId;

  it("resolveRoleDefinition：内置角色逐字返回 ROLE_DEFINITIONS，自定义角色返回提示词原文（去首尾空白）", () => {
    expect(resolveRoleDefinition("planner")).toBe(ROLE_DEFINITIONS.planner);
    expect(resolveRoleDefinition("worker")).toBe(ROLE_DEFINITIONS.worker);
    expect(resolveRoleDefinition("reviewer")).toBe(ROLE_DEFINITIONS.reviewer);
    expect(resolveRoleDefinition(customId, "  你是文档撰写者。\n")).toBe("你是文档撰写者。");
  });

  it("自定义角色缺定义抛错（空第 1 层宁可当场失败）", () => {
    expect(() => resolveRoleDefinition(customId)).toThrow(/未提供角色提示词/);
    expect(() => resolveRoleDefinition(customId, "  \n ")).toThrow(/未提供角色提示词/);
  });

  it("assemblePrompt：自定义角色第 1 层为其提示词原文，其余层照常", () => {
    const out = assemblePrompt({
      role: customId,
      customRoleDefinition: "你是文档撰写者。只改 docs/。",
      input: { kind: "message", text: "写一份 README" },
      projectMemory: [mem({ id: "d1", category: "decision", title: "用 pnpm" })],
      outputLanguage: LANG,
    });
    expect(out).toContain("# 角色\n你是文档撰写者。只改 docs/。");
    expect(out).toContain("用 pnpm");
    expect(out).toContain("写一份 README");
  });

  it("内置角色行为逐字不变：worker 组装含 ROLE_DEFINITIONS.worker 原文", () => {
    const out = assemblePrompt({
      role: "worker",
      input: { kind: "task", contract: contract({}) },
      projectMemory: [],
      outputLanguage: LANG,
    });
    expect(out).toContain(`# 角色\n${ROLE_DEFINITIONS.worker}`);
  });
});
