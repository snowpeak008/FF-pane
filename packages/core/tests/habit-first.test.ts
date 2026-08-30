/**
 * T5.3 单测：习惯先行判定（设计文档 §8.2.3）。纯函数。
 * 覆盖：workflow 习惯存在性判定、「直接做」跳过识别、指令文本非空。
 */

import type { HabitEntry, HabitEntryId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  HABIT_FIRST_INSTRUCTION,
  hasActiveWorkflowHabit,
  isDirectExecuteRequest,
} from "../src/index.js";

function habit(o: Partial<HabitEntry>): HabitEntry {
  return {
    id: "hab-x" as HabitEntryId,
    category: "workflow",
    content: "先跑测试",
    status: "active",
    enabled: true,
    source: { kind: "user_manual" },
    importance: 50,
    createdAt: 1,
    updatedAt: 1,
    ...o,
  } as HabitEntry;
}

describe("hasActiveWorkflowHabit", () => {
  it("有 active+enabled 的 workflow 习惯 → true", () => {
    expect(hasActiveWorkflowHabit([habit({})])).toBe(true);
  });

  it("workflow 但停用 / 候选 / 归档 → false；非 workflow → false；空 → false", () => {
    expect(hasActiveWorkflowHabit([habit({ enabled: false })])).toBe(false);
    expect(hasActiveWorkflowHabit([habit({ status: "candidate" })])).toBe(false);
    expect(hasActiveWorkflowHabit([habit({ status: "archived" })])).toBe(false);
    expect(hasActiveWorkflowHabit([habit({ category: "tech" })])).toBe(false);
    expect(hasActiveWorkflowHabit([])).toBe(false);
  });
});

describe("isDirectExecuteRequest", () => {
  it("句首「直接做」触发；句中出现不触发；空白容忍", () => {
    expect(isDirectExecuteRequest("直接做")).toBe(true);
    expect(isDirectExecuteRequest("直接做吧")).toBe(true);
    expect(isDirectExecuteRequest("  直接做，别问了")).toBe(true);
    expect(isDirectExecuteRequest("先直接做完 A 再说")).toBe(false);
    expect(isDirectExecuteRequest("帮我做个登录页")).toBe(false);
    expect(isDirectExecuteRequest("")).toBe(false);
  });
});

describe("HABIT_FIRST_INSTRUCTION", () => {
  it("非空且点明整形与确认语义", () => {
    expect(HABIT_FIRST_INSTRUCTION.length).toBeGreaterThan(0);
    expect(HABIT_FIRST_INSTRUCTION).toContain("习惯先行");
    expect(HABIT_FIRST_INSTRUCTION).toContain("确认");
  });
});
