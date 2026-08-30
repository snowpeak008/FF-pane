/**
 * T4.6 结构化计划生成单测：Planner 输出 → 计划草案变更（parsePlannerPlanDraft）
 * 与创世草案（createInitialDraft）。纯函数、无 IO。
 */

import { describe, expect, it } from "vitest";
import { createInitialDraft, PLAN_OUTPUT_CONTRACT, parsePlannerPlanDraft } from "../src/index.js";

/** 包装成带 ```json 围栏的答复文本。 */
function fenced(json: unknown): string {
  return `好的，这是计划：\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

const FULL_PLAN = {
  goal: "给示例项目加一个工具函数并通过测试",
  scope: ["新增 sum 函数", "补单测"],
  nonGoals: ["不改构建配置"],
  constraints: ["只动 src/ 与 tests/"],
  decisions: ["用 vitest"],
  acceptance: ["pnpm test 通过"],
  tasks: [
    {
      id: "t1",
      goal: "实现 sum",
      writeScope: ["src/**"],
      forbidden: ["改 package.json"],
      dependsOn: [],
      acceptance: ["导出 sum(a,b)"],
      verifyCmd: "pnpm test",
    },
    {
      id: "t2",
      goal: "补单测",
      writeScope: ["tests/**"],
      forbidden: [],
      dependsOn: ["t1"],
      acceptance: ["覆盖正负数"],
    },
  ],
};

describe("parsePlannerPlanDraft", () => {
  it("happy：完整计划块 → 逐字段解析，任务合同齐全", () => {
    const result = parsePlannerPlanDraft(fenced(FULL_PLAN));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const c = result.changes;
    expect(c.goal).toBe(FULL_PLAN.goal);
    expect(c.scope).toEqual(["新增 sum 函数", "补单测"]);
    expect(c.acceptance).toEqual(["pnpm test 通过"]);
    expect(c.tasks).toHaveLength(2);
    expect(c.tasks?.[0]).toMatchObject({
      id: "t1",
      goal: "实现 sum",
      writeScope: ["src/**"],
      forbidden: ["改 package.json"],
      dependsOn: [],
      contextRefs: [],
      acceptance: ["导出 sum(a,b)"],
      verifyCmd: "pnpm test",
    });
    // t2 依赖 t1（引用完整）
    expect(c.tasks?.[1]?.dependsOn).toEqual(["t1"]);
    // 无 verifyCmd 的任务不带该字段（exactOptionalPropertyTypes）
    expect("verifyCmd" in (c.tasks?.[1] ?? {})).toBe(false);
  });

  it("多个围栏块 → 取最后一个 json 块", () => {
    const first = fenced({ goal: "旧", tasks: [{ id: "a", goal: "x" }] });
    const second = fenced({ goal: "新", tasks: [{ id: "b", goal: "y" }] });
    const result = parsePlannerPlanDraft(`${first}\n改一下：\n${second}`);
    expect(result.ok && result.changes.goal).toBe("新");
  });

  it("无标签围栏块也能解析（```… 无 json 标签）", () => {
    const result = parsePlannerPlanDraft(
      '```\n{"goal":"g","tasks":[{"id":"t1","goal":"do"}]}\n```',
    );
    expect(result.ok).toBe(true);
  });

  it("dependsOn 悬空引用被丢弃（容模型噪声）", () => {
    const result = parsePlannerPlanDraft(
      fenced({ goal: "g", tasks: [{ id: "t1", goal: "do", dependsOn: ["nope", "t1"] }] }),
    );
    expect(result.ok).toBe(true);
    // "nope" 不存在 → 丢弃；"t1" 自引用 → 丢弃
    expect(result.ok && result.changes.tasks?.[0]?.dependsOn).toEqual([]);
  });

  it("缺 id 的任务自动编号 t<序号>，缺 goal 的任务丢弃", () => {
    const result = parsePlannerPlanDraft(
      fenced({
        goal: "g",
        tasks: [{ goal: "第一件事" }, { id: "", goal: "" }, { goal: "第三件事" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // 中间无 goal 的被丢弃，保留两条，id 按原索引编号
    expect(result.changes.tasks?.map((t) => t.id)).toEqual(["t1", "t3"]);
  });

  it("重复 id 去重（后者退化为 t<序号>）", () => {
    const result = parsePlannerPlanDraft(
      fenced({
        goal: "g",
        tasks: [
          { id: "same", goal: "a" },
          { id: "same", goal: "b" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    const ids = result.ok ? result.changes.tasks?.map((t) => t.id) : [];
    expect(new Set(ids).size).toBe(2);
  });

  it("无 json 块 → 失败并给出中文原因", () => {
    const result = parsePlannerPlanDraft("我觉得可以分三步做，但这里只是聊天。");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("未找到 JSON 计划块");
  });

  it("JSON 非法 → 失败", () => {
    const result = parsePlannerPlanDraft("```json\n{ not valid json }\n```");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("JSON 解析失败");
  });

  it("缺 goal → 失败", () => {
    const result = parsePlannerPlanDraft(fenced({ tasks: [{ id: "t1", goal: "x" }] }));
    expect(result.ok === false && result.error).toContain("goal");
  });

  it("无有效任务 → 失败", () => {
    const result = parsePlannerPlanDraft(fenced({ goal: "g", tasks: [] }));
    expect(result.ok === false && result.error).toContain("有效任务");
  });

  it("PLAN_OUTPUT_CONTRACT 提及 json 与 tasks（供 Planner 遵循）", () => {
    expect(PLAN_OUTPUT_CONTRACT).toContain("json");
    expect(PLAN_OUTPUT_CONTRACT).toContain("tasks");
  });
});

describe("createInitialDraft", () => {
  it("造 v1 draft，任务 planVersion 重绑为 1", () => {
    const parsed = parsePlannerPlanDraft(fenced(FULL_PLAN));
    if (!parsed.ok) {
      throw new Error("解析应成功");
    }
    const plan = createInitialDraft(parsed.changes);
    expect(plan.version).toBe(1);
    expect(plan.status).toBe("draft");
    expect(plan.goal).toBe(FULL_PLAN.goal);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks.every((t) => t.planVersion === 1)).toBe(true);
    expect(plan.approvedBy).toBeUndefined();
  });

  it("缺省字段兜底为空数组/空串", () => {
    const plan = createInitialDraft({ goal: "只有目标" });
    expect(plan.goal).toBe("只有目标");
    expect(plan.scope).toEqual([]);
    expect(plan.tasks).toEqual([]);
    expect(plan.acceptance).toEqual([]);
  });
});
