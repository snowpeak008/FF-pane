import type { Plan } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { diffLines, planToText, planVersionDiff } from "../src/renderer/src/pages/plan/plan-diff";

function plan(overrides: Partial<Plan>): Plan {
  return {
    version: 1,
    status: "draft",
    goal: "g",
    scope: [],
    nonGoals: [],
    constraints: [],
    decisions: [],
    tasks: [],
    acceptance: [],
    ...overrides,
  } as unknown as Plan;
}

describe("diffLines (LCS)", () => {
  it("相同文本无增删（全为上下文行）", () => {
    const out = diffLines("a\nb\nc", "a\nb\nc");
    expect(out).toBe(" a\n b\n c");
  });

  it("替换一行 = 删旧 + 增新", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toBe(" a\n-b\n+x\n c");
  });

  it("纯新增（旧为空段）", () => {
    expect(diffLines("a", "a\nb")).toBe(" a\n+b");
  });

  it("纯删除", () => {
    expect(diffLines("a\nb", "a")).toBe(" a\n-b");
  });
});

describe("planToText", () => {
  it("含目标与范围条目、字段顺序固定", () => {
    const text = planToText(plan({ goal: "ship it", scope: ["x", "y"] }));
    expect(text).toContain("Goal: ship it");
    expect(text).toContain("Scope:");
    expect(text).toContain("- x");
    expect(text).toContain("- y");
  });
});

describe("planVersionDiff", () => {
  it("目标变化体现为一删一增", () => {
    const out = planVersionDiff(plan({ goal: "old" }), plan({ goal: "new" }));
    expect(out).toContain("-Goal: old");
    expect(out).toContain("+Goal: new");
  });
});
