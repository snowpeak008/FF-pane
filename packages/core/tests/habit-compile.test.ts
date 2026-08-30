/**
 * T5.2 单测：习惯档案编译器（设计文档 §8.2.2）。纯函数，输出可快照。
 * 覆盖：过滤（active+enabled）、类别分组与顺序、importance 排序、workflow 标注、空集兜底。
 */

import type { HabitEntry, HabitEntryId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { compileHabitProfile } from "../src/index.js";

function habit(o: Partial<HabitEntry>): HabitEntry {
  return {
    id: "hab-x" as HabitEntryId,
    category: "workflow",
    content: "内容",
    status: "active",
    enabled: true,
    source: { kind: "user_manual" },
    importance: 50,
    createdAt: 1,
    updatedAt: 1,
    ...o,
  } as HabitEntry;
}

describe("compileHabitProfile", () => {
  it("空集 / 无 active+enabled → undefined（第 2 层落占位）", () => {
    expect(compileHabitProfile([])).toBeUndefined();
    expect(
      compileHabitProfile([
        habit({ status: "candidate" }),
        habit({ enabled: false }),
        habit({ status: "archived" }),
      ]),
    ).toBeUndefined();
  });

  it("按类别分组、顺序 workflow→tech→communication→environment，workflow 标注流程约束", () => {
    const text = compileHabitProfile([
      habit({ id: "h-env" as HabitEntryId, category: "environment", content: "Windows 用 hoist" }),
      habit({ id: "h-wf" as HabitEntryId, category: "workflow", content: "先跑测试" }),
      habit({ id: "h-tech" as HabitEntryId, category: "tech", content: "优先 TypeScript" }),
      habit({ id: "h-comm" as HabitEntryId, category: "communication", content: "回复用中文" }),
    ]);
    expect(text).toBe(
      [
        "## 流程约束（执行前必须遵守）",
        "- 先跑测试",
        "",
        "## 技术偏好",
        "- 优先 TypeScript",
        "",
        "## 沟通偏好",
        "- 回复用中文",
        "",
        "## 环境经验",
        "- Windows 用 hoist",
      ].join("\n"),
    );
  });

  it("组内按 importance 降序，同值按 updatedAt 降序", () => {
    const text = compileHabitProfile([
      habit({ id: "a" as HabitEntryId, content: "低", importance: 10, updatedAt: 100 }),
      habit({ id: "b" as HabitEntryId, content: "高", importance: 90, updatedAt: 1 }),
      habit({ id: "c" as HabitEntryId, content: "同重较新", importance: 10, updatedAt: 200 }),
    ]);
    expect(text).toBe(["## 流程约束（执行前必须遵守）", "- 高", "- 同重较新", "- 低"].join("\n"));
  });

  it("只有非 workflow 类别时也能编译（无 workflow 组）", () => {
    const text = compileHabitProfile([habit({ category: "tech", content: "优先 TS" })]);
    expect(text).toBe(["## 技术偏好", "- 优先 TS"].join("\n"));
  });
});
