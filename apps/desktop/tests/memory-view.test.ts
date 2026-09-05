import type { MemoryEntry } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  applyMemorySearch,
  groupByCategory,
  MEMORY_CATEGORY_ORDER,
  matchesMemorySearch,
} from "../src/renderer/src/pages/memory/memory-view";

function entry(overrides: Partial<Record<keyof MemoryEntry, unknown>>): MemoryEntry {
  return {
    id: "mem-1",
    category: "decision",
    title: "标题",
    body: "正文",
    status: "active",
    source: { kind: "user_manual" },
    confidence: "high",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as MemoryEntry;
}

describe("matchesMemorySearch", () => {
  it("空查询恒命中", () => {
    expect(matchesMemorySearch(entry({}), "  ")).toBe(true);
  });
  it("命中标题 / 正文（大小写不敏感）", () => {
    expect(matchesMemorySearch(entry({ title: "Use Vitest" }), "vitest")).toBe(true);
    expect(matchesMemorySearch(entry({ body: "prefer PNPM" }), "pnpm")).toBe(true);
  });
  it("命中标签", () => {
    expect(matchesMemorySearch(entry({ tags: ["ci", "build"] }), "build")).toBe(true);
  });
  it("不命中返回 false", () => {
    expect(matchesMemorySearch(entry({ title: "a", body: "b" }), "zzz")).toBe(false);
  });
});

describe("applyMemorySearch（T8.7：混合检索结果 + 本地回退）", () => {
  const entries = [
    entry({ id: "a", title: "执行 vitest 命令" }),
    entry({ id: "b", title: "部署流程" }),
    entry({ id: "c", title: "错误处理约定" }),
  ];

  it("空查询原样返回全部条目", () => {
    expect(applyMemorySearch(entries, "  ", undefined)).toEqual(entries);
    expect(applyMemorySearch(entries, "", ["b"])).toEqual(entries);
  });

  it("命中列表可用时按命中顺序返回（保留 RRF 融合排序）", () => {
    const matched = applyMemorySearch(entries, "语义查询", ["c", "a"]);
    expect(matched.map((e) => e.id)).toEqual(["c", "a"]);
  });

  it("命中里引用了本地没有的 id（列表间隙）：静默跳过", () => {
    const matched = applyMemorySearch(entries, "查询", ["b", "mem-gone"]);
    expect(matched.map((e) => e.id)).toEqual(["b"]);
  });

  it("ids 为 undefined（在飞 / 失败）回退本地子串过滤", () => {
    const matched = applyMemorySearch(entries, "vitest", undefined);
    expect(matched.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("groupByCategory", () => {
  it("按类别归组，覆盖全部类别", () => {
    const groups = groupByCategory([
      entry({ id: "a", category: "decision" }),
      entry({ id: "b", category: "rule" }),
      entry({ id: "c", category: "decision" }),
    ]);
    expect(groups.decision.map((e) => e.id)).toEqual(["a", "c"]);
    expect(groups.rule.map((e) => e.id)).toEqual(["b"]);
    expect(groups.lesson).toEqual([]);
    expect(groups.state).toEqual([]);
  });
  it("类别顺序为四类", () => {
    expect(MEMORY_CATEGORY_ORDER).toEqual(["decision", "rule", "lesson", "state"]);
  });
});
