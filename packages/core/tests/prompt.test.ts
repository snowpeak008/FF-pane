/**
 * T4.1 Prompt 组装层单测：四层组装结构、记忆注入按角色选条 + 上限截断、
 * 输出语言三级级联。纯逻辑，无 IO。
 */

import type {
  AiOutputLanguageSettings,
  MemoryCategory,
  MemoryEntry,
  TaskContract,
} from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  assemblePrompt,
  DEFAULT_INJECTION_LIMIT,
  outputLanguageInstruction,
  resolveOutputLanguage,
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
