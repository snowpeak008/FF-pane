/**
 * T5.1 单测：习惯入库前的相近条目检测（设计文档 §8.2.5）。
 * 纯函数、零 IO：验证相似度、阈值、同类加成、excludeId、排序与截断。
 */

import type { HabitEntry, HabitEntryId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { detectHabitConflicts, habitTextSimilarity } from "../src/index.js";

function habit(id: string, content: string, overrides: Partial<HabitEntry> = {}): HabitEntry {
  return {
    id: id as HabitEntryId,
    category: "workflow",
    content,
    status: "active",
    enabled: true,
    source: { kind: "user_manual" },
    importance: 50,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  } as HabitEntry;
}

describe("habitTextSimilarity", () => {
  it("完全相同 → 1；毫不相干 → 低", () => {
    expect(habitTextSimilarity("先跑测试再改代码", "先跑测试再改代码")).toBe(1);
    expect(habitTextSimilarity("回复用中文", "数据库默认 SQLite")).toBeLessThan(0.3);
  });

  it("标点 / 大小写 / 空白差异被归一化", () => {
    expect(habitTextSimilarity("Prefer TypeScript.", "prefer   typescript")).toBeGreaterThan(0.8);
  });
});

describe("detectHabitConflicts", () => {
  const existing = [
    habit("h1", "任何改动前先跑一遍现有测试"),
    habit("h2", "回复一律用中文", { category: "communication" }),
    habit("h3", "数据库默认用 SQLite", { category: "tech" }),
  ];

  it("找出相近条目并按相似度降序", () => {
    const hits = detectHabitConflicts(
      { category: "workflow", content: "改动前先跑一遍现有测试" },
      existing,
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.entry.id).toBe("h1");
    expect(hits[0]?.similarity).toBeGreaterThan(0.4);
  });

  it("不相干输入 → 空", () => {
    const hits = detectHabitConflicts(
      { category: "environment", content: "Windows 下 pnpm 需要 shamefully-hoist" },
      existing,
    );
    expect(hits).toEqual([]);
  });

  it("excludeId 排除自身（编辑场景）", () => {
    const hits = detectHabitConflicts(
      {
        category: "workflow",
        content: "任何改动前先跑一遍现有测试",
        excludeId: "h1" as HabitEntryId,
      },
      existing,
    );
    expect(hits.find((h) => h.entry.id === "h1")).toBeUndefined();
  });

  it("阈值可覆盖，limit 截断", () => {
    const many = [
      habit("a", "先跑测试"),
      habit("b", "先跑测试再改"),
      habit("c", "先跑一下测试"),
      habit("d", "先跑测试然后改代码"),
    ];
    const hits = detectHabitConflicts({ category: "workflow", content: "先跑测试" }, many, {
      threshold: 0.1,
      limit: 2,
    });
    expect(hits).toHaveLength(2);
    // 降序：相似度不递增
    expect(hits[0]?.similarity).toBeGreaterThanOrEqual(hits[1]?.similarity ?? 0);
  });
});
