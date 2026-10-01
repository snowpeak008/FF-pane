/**
 * 窗口角色提示的语言段与习惯段：有无语言、习惯筛选、超长截断。
 */

import type { HabitEntry, HabitEntryId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  composeLaunchRolePrompt,
  habitPromptSection,
  outputLanguagePromptSection,
} from "../src/index.js";

function habit(overrides: Partial<HabitEntry>): HabitEntry {
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
    ...overrides,
  } as HabitEntry;
}

describe("outputLanguagePromptSection", () => {
  it("简体中文和 English 会写进提示", () => {
    expect(outputLanguagePromptSection("zh-CN")).toContain("简体中文");
    expect(outputLanguagePromptSection("en-US")).toContain("English");
  });

  it("没设、跟随或无法识别时不写", () => {
    expect(outputLanguagePromptSection(undefined)).toBeUndefined();
    expect(outputLanguagePromptSection("")).toBeUndefined();
    expect(outputLanguagePromptSection("follow")).toBeUndefined();
    expect(outputLanguagePromptSection("ja-JP")).toBeUndefined();
  });
});

describe("habitPromptSection", () => {
  it("只保留已通过且启用的习惯", () => {
    const text = habitPromptSection([
      habit({ id: "on" as HabitEntryId, content: "要带上" }),
      habit({ id: "off" as HabitEntryId, content: "停用的", enabled: false }),
      habit({ id: "wait" as HabitEntryId, content: "待审核", status: "candidate" }),
      habit({ id: "gone" as HabitEntryId, content: "已归档", status: "archived" }),
    ]);
    expect(text).toContain("要带上");
    expect(text).not.toContain("停用的");
    expect(text).not.toContain("待审核");
    expect(text).not.toContain("已归档");
  });

  it("没有可写入的习惯时不写", () => {
    expect(habitPromptSection(undefined)).toBeUndefined();
    expect(habitPromptSection([])).toBeUndefined();
    expect(habitPromptSection([habit({ enabled: false })])).toBeUndefined();
  });

  it("超出上限时截断并说明，长度不超过上限", () => {
    const text = habitPromptSection(
      [
        habit({ content: "甲".repeat(200) }),
        habit({ id: "b" as HabitEntryId, content: "乙".repeat(200) }),
      ],
      80,
    );
    expect(text).toBeDefined();
    expect(text?.length).toBeLessThanOrEqual("# 用户习惯\n".length + 80);
    expect(text).toContain("其余习惯因长度上限未写入");
    expect(text?.includes("甲".repeat(200)) && text?.includes("乙".repeat(200))).toBe(false);
  });
});

describe("composeLaunchRolePrompt", () => {
  it("没有语言也没有习惯时保持角色提示原文", () => {
    expect(
      composeLaunchRolePrompt({
        rolePrompt: "你是执行。",
        outputLanguage: "follow",
        habits: [],
      }),
    ).toBe("你是执行。");
  });

  it("语言和习惯都接在角色提示后面", () => {
    const text = composeLaunchRolePrompt({
      rolePrompt: "你是执行。",
      outputLanguage: "zh-CN",
      habits: [habit({ content: "改动前先跑测试" })],
    });
    expect(text.startsWith("你是执行。")).toBe(true);
    expect(text).toContain("# 输出语言");
    expect(text).toContain("# 用户习惯");
    expect(text).toContain("改动前先跑测试");
  });
});
