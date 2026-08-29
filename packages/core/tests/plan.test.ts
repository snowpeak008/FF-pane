import type {
  Plan,
  PlanApproval,
  PlanStatus,
  PlanVersion,
  TaskContract,
  TaskId,
} from "@ff-pane/shared";
import { PLAN_STATUSES } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  approvePlan,
  cancelPlan,
  canTransitionPlan,
  completePlan,
  createNextDraft,
  PLAN_LEGAL_TRANSITIONS,
  PlanTransitionError,
  supersedePlan,
} from "../src/index.js";

const APPROVED_AT = 1_756_000_000_000;

const version = (value: number): PlanVersion => value as PlanVersion;

const userApproval = (): PlanApproval => ({ by: "user", at: APPROVED_AT });

const contract = (id: string, planVersion: number): TaskContract => ({
  id: id as TaskId,
  planVersion: version(planVersion),
  goal: "实现计划状态机",
  writeScope: ["packages/core/src/plan/**"],
  forbidden: ["禁止 IO"],
  dependsOn: [],
  contextRefs: [],
  acceptance: ["全矩阵测试通过"],
});

/** 构造处于指定状态的计划；非 draft 状态附带批准记录（模拟真实演进痕迹）。 */
function makePlan(status: PlanStatus): Plan {
  const base: Plan = {
    version: version(1),
    status,
    goal: "构建 FF-pane 计划页",
    scope: ["计划状态机"],
    nonGoals: ["不含 UI"],
    constraints: ["零 IO"],
    decisions: ["版本号只增不改"],
    tasks: [contract("task-1", 1)],
    acceptance: ["pnpm test 全绿"],
  };
  return status === "draft" ? base : { ...base, approvedBy: userApproval() };
}

/** 与实现相互独立的期望矩阵：实现侧迁移表若被误改，此处立刻失败。 */
const EXPECTED_LEGAL: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ["approved", "superseded", "cancelled"],
  approved: ["superseded", "completed", "cancelled"],
  superseded: [],
  completed: [],
  cancelled: [],
};

/** 每个迁移目标对应的迁移函数（draft 不是任何迁移函数的目标，见矩阵测试）。 */
const TRANSITION_FNS: Record<Exclude<PlanStatus, "draft">, (plan: Plan) => Plan> = {
  approved: (plan) => approvePlan(plan, userApproval()),
  superseded: supersedePlan,
  completed: completePlan,
  cancelled: cancelPlan,
};

describe("Plan 合法迁移表", () => {
  it("覆盖全部 5 个状态且与期望矩阵全等", () => {
    expect(Object.keys(PLAN_LEGAL_TRANSITIONS).sort()).toEqual([...PLAN_STATUSES].sort());
    for (const from of PLAN_STATUSES) {
      expect([...PLAN_LEGAL_TRANSITIONS[from]].sort()).toEqual([...EXPECTED_LEGAL[from]].sort());
    }
  });

  it("canTransitionPlan 对未知状态一律返回 false（不抛错，供 UI 使用）", () => {
    expect(canTransitionPlan("rogue" as PlanStatus, "approved")).toBe(false);
    expect(canTransitionPlan("draft", "rogue" as PlanStatus)).toBe(false);
  });
});

describe("5×5 全矩阵：合法迁移全覆盖 + 非法迁移全部抛错", () => {
  for (const from of PLAN_STATUSES) {
    for (const to of PLAN_STATUSES) {
      const legal = EXPECTED_LEGAL[from].includes(to);
      it(`${from} → ${to}：${legal ? "合法" : "非法"}`, () => {
        expect(canTransitionPlan(from, to)).toBe(legal);
        if (to === "draft") {
          // 不存在以 draft 为目标的迁移函数：进入 draft 的唯一途径是
          // createNextDraft 产生 version+1 的新计划对象（版本只增不改）。
          expect(legal).toBe(false);
          return;
        }
        const run = TRANSITION_FNS[to];
        const plan = makePlan(from);
        const snapshot = structuredClone(plan);
        if (legal) {
          const next = run(plan);
          expect(next.status).toBe(to);
          expect(next).not.toBe(plan);
        } else {
          try {
            run(plan);
            expect.unreachable(`非法迁移 ${from} → ${to} 未抛错`);
          } catch (error) {
            expect(error).toBeInstanceOf(PlanTransitionError);
            const transitionError = error as PlanTransitionError;
            expect(transitionError.from).toBe(from);
            expect(transitionError.to).toBe(to);
            expect(transitionError.reason.length).toBeGreaterThan(0);
          }
        }
        // 无论成功失败，入参计划对象一律不被修改
        expect(plan).toEqual(snapshot);
      });
    }
  }
});

describe("approvePlan", () => {
  it("写入批准记录与时间，且返回新对象", () => {
    const draft = makePlan("draft");
    const approved = approvePlan(draft, userApproval());
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toEqual({ by: "user", at: APPROVED_AT });
    expect(draft.approvedBy).toBeUndefined();
  });

  it("拒绝非 user 批准（运行时伪造数据）", () => {
    const forged = { by: "planner", at: APPROVED_AT } as unknown as PlanApproval;
    try {
      approvePlan(makePlan("draft"), forged);
      expect.unreachable("非 user 批准未被拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanTransitionError);
      const transitionError = error as PlanTransitionError;
      expect(transitionError.from).toBe("draft");
      expect(transitionError.to).toBe("approved");
      expect(transitionError.reason).toContain("用户");
    }
  });

  it("拒绝畸形批准时间戳（数据损坏按 TypeError 处理）", () => {
    expect(() => approvePlan(makePlan("draft"), { by: "user", at: Number.NaN })).toThrowError(
      TypeError,
    );
    expect(() => approvePlan(makePlan("draft"), { by: "user", at: 0 })).toThrowError(TypeError);
  });
});

describe("入参校验：未知状态视为数据损坏", () => {
  it("迁移函数收到未知状态抛 TypeError 而非状态机错误", () => {
    const corrupted = { ...makePlan("draft"), status: "rogue" as PlanStatus };
    expect(() => supersedePlan(corrupted)).toThrowError(TypeError);
    expect(() => createNextDraft(corrupted, {})).toThrowError(TypeError);
  });
});

describe("createNextDraft", () => {
  it("产生 version+1 的新 draft，未修改字段沿用底稿，旧计划原样不动", () => {
    const approved = approvePlan(makePlan("draft"), userApproval());
    const snapshot = structuredClone(approved);
    const next = createNextDraft(approved, { goal: "范围收窄后的新目标" });
    expect(next.version).toBe(2);
    expect(next.status).toBe("draft");
    expect(next.goal).toBe("范围收窄后的新目标");
    expect(next.scope).toEqual(approved.scope);
    expect(approved).toEqual(snapshot);
  });

  it("新草案不携带批准记录（连 approvedBy 键都不存在）", () => {
    const approved = approvePlan(makePlan("draft"), userApproval());
    const next = createNextDraft(approved, {});
    expect("approvedBy" in next).toBe(false);
  });

  it("任务合同的 planVersion 一律重绑到新版本（沿用与传入两种来源）", () => {
    const approved = approvePlan(makePlan("draft"), userApproval());
    const inherited = createNextDraft(approved, {});
    expect(inherited.tasks.every((task) => task.planVersion === 2)).toBe(true);
    const replaced = createNextDraft(approved, { tasks: [contract("task-9", 1)] });
    expect(replaced.tasks[0]?.planVersion).toBe(2);
  });

  it("draft 底稿允许：新草案取代旧草案", () => {
    const next = createNextDraft(makePlan("draft"), {});
    expect(next.version).toBe(2);
    expect(next.status).toBe("draft");
  });

  it("superseded / completed / cancelled 底稿一律拒绝", () => {
    for (const status of ["superseded", "completed", "cancelled"] as const) {
      try {
        createNextDraft(makePlan(status), {});
        expect.unreachable(`${status} 底稿未被拒绝`);
      } catch (error) {
        expect(error).toBeInstanceOf(PlanTransitionError);
        const transitionError = error as PlanTransitionError;
        expect(transitionError.from).toBe(status);
        expect(transitionError.to).toBe("draft");
      }
    }
  });

  it("连续演进版本号只增：v1 → v2 → v3", () => {
    const v1 = makePlan("draft");
    const v2 = createNextDraft(v1, {});
    const v3 = createNextDraft(approvePlan(v2, userApproval()), {});
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
  });

  it("拒绝畸形底稿版本号（数据损坏按 TypeError 处理）", () => {
    expect(() => createNextDraft({ ...makePlan("draft"), version: version(0) }, {})).toThrowError(
      TypeError,
    );
    expect(() => createNextDraft({ ...makePlan("draft"), version: version(1.5) }, {})).toThrowError(
      TypeError,
    );
  });
});

describe("PlanTransitionError", () => {
  it("携带 from / to / reason，message 可读", () => {
    const error = new PlanTransitionError("completed", "approved", "completed 是终态");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PlanTransitionError");
    expect(error.from).toBe("completed");
    expect(error.to).toBe("approved");
    expect(error.reason).toBe("completed 是终态");
    expect(error.message).toContain("completed → approved");
  });
});
