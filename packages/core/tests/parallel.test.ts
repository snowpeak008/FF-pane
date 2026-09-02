/**
 * T8.3a 任务并行纯逻辑单测：writePaths 互斥核查（相同 / 包含 / 兄弟 / 大小写 /
 * 分隔符 / `..` / 空集 / 自反 / glob 保守判定 / 多相交收齐）+ 在飞轮次表
 * （登记 / 注销 / 列表 / 轮级裁决）。
 */

import type { EpochMillis, LocalSessionId, Role, TaskId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  type ActiveTurnRecord,
  checkTurnParallelism,
  checkWritePathsExclusive,
  detectScopeOverlap,
  EMPTY_ACTIVE_TURN_TABLE,
  listActiveTurns,
  type ParallelWriteTask,
  registerActiveTurn,
  unregisterActiveTurn,
} from "../src/index.js";

function writeTask(id: string, writePaths: readonly string[]): ParallelWriteTask {
  return { id, writePaths };
}

describe("detectScopeOverlap：两条 writePaths 条目的重叠判定", () => {
  it("相同路径 → identical；写法差异（大小写 / 分隔符 / 尾斜杠 / `./`）归一后同样 identical", () => {
    expect(detectScopeOverlap("src/app", "src/app")).toBe("identical");
    expect(detectScopeOverlap("SRC/APP", "src/app")).toBe("identical");
    expect(detectScopeOverlap("src\\app", "src/app")).toBe("identical");
    expect(detectScopeOverlap("src/app/", "src/app")).toBe("identical");
    expect(detectScopeOverlap("./src/app", "src/app")).toBe("identical");
    // 子树语义：`src/app/**` 与裸 `src/app` 是同一个子树
    expect(detectScopeOverlap("src/app/**", "src/app")).toBe("identical");
  });

  it("前缀包含（以路径段为界）→ containment", () => {
    expect(detectScopeOverlap("src", "src/app")).toBe("containment");
    expect(detectScopeOverlap("src/app/deep", "src")).toBe("containment");
    // 项目根子树（"**"）包含一切
    expect(detectScopeOverlap("**", "src/app")).toBe("containment");
  });

  it("兄弟路径与字符串前缀但非路径段前缀 → 不相交（null）", () => {
    expect(detectScopeOverlap("src/app", "src/lib")).toBeNull();
    // 关键边界：src/app 是 src/app2 的字符串前缀，但不是路径段前缀
    expect(detectScopeOverlap("src/app", "src/app2")).toBeNull();
    expect(detectScopeOverlap("docs", "src")).toBeNull();
  });

  it("`..` 攀升 / 项目外形态的条目不贡献写权限 → 与一切不相交", () => {
    expect(detectScopeOverlap("../outside", "src")).toBeNull();
    expect(detectScopeOverlap("src/../..", "**")).toBeNull();
    expect(detectScopeOverlap("C:/abs/path", "**")).toBeNull();
    expect(detectScopeOverlap("~/home", "**")).toBeNull();
  });

  it("glob：静态前缀子树不相交 → null；相交但证不出包含 → may-overlap；glob ⊆ 子树 → containment", () => {
    expect(detectScopeOverlap("src/*.ts", "docs/guide")).toBeNull();
    expect(detectScopeOverlap("src/*.ts", "src/*.md")).toBe("may-overlap");
    expect(detectScopeOverlap("src/**/*.ts", "src")).toBe("containment");
    // 同一 glob 规范形态相等 → identical
    expect(detectScopeOverlap("src/*.ts", "SRC\\*.ts")).toBe("identical");
  });
});

describe("checkWritePathsExclusive：候选 vs 在飞任务集", () => {
  it("不相交 → 可并行", () => {
    const decision = checkWritePathsExclusive(writeTask("task-a", ["src/app"]), [
      writeTask("task-b", ["src/lib", "docs"]),
    ]);
    expect(decision).toEqual({ canRunInParallel: true });
  });

  it("相交 → 拒绝，明细含两个任务 ID、两条原文路径与人可读原因", () => {
    const decision = checkWritePathsExclusive(writeTask("task-a", ["SRC\\App"]), [
      writeTask("task-b", ["src/app/views"]),
    ]);
    expect(decision.canRunInParallel).toBe(false);
    if (decision.canRunInParallel) {
      return;
    }
    expect(decision.conflicts).toHaveLength(1);
    const [conflict] = decision.conflicts;
    expect(conflict).toMatchObject({
      candidateId: "task-a",
      inflightId: "task-b",
      candidatePath: "SRC\\App",
      inflightPath: "src/app/views",
      relation: "containment",
    });
    expect(conflict?.reason).toContain("task-a");
    expect(conflict?.reason).toContain("task-b");
    expect(conflict?.reason).toContain("SRC\\App");
    expect(conflict?.reason).toContain("src/app/views");
    expect(conflict?.reason).toContain("包含");
  });

  it("多处相交全部收齐（不止第一处），跨多个在飞任务", () => {
    const decision = checkWritePathsExclusive(writeTask("task-a", ["src/app", "docs"]), [
      writeTask("task-b", ["src/app/views"]),
      writeTask("task-c", ["docs", "tools"]),
    ]);
    expect(decision.canRunInParallel).toBe(false);
    if (decision.canRunInParallel) {
      return;
    }
    expect(decision.conflicts).toHaveLength(2);
    expect(decision.conflicts.map((c) => [c.inflightId, c.relation])).toEqual([
      ["task-b", "containment"],
      ["task-c", "identical"],
    ]);
  });

  it("空 writePaths = 无写权限（仓内语义）：与任何任务可并行，双向成立", () => {
    expect(checkWritePathsExclusive(writeTask("planner", []), [writeTask("t", ["**"])])).toEqual({
      canRunInParallel: true,
    });
    expect(checkWritePathsExclusive(writeTask("t", ["**"]), [writeTask("planner", [])])).toEqual({
      canRunInParallel: true,
    });
  });

  it("全无效条目（`..` / 绝对路径）等价于空 writePaths → 可并行", () => {
    const decision = checkWritePathsExclusive(writeTask("task-a", ["../up", "C:/abs"]), [
      writeTask("task-b", ["**"]),
    ]);
    expect(decision).toEqual({ canRunInParallel: true });
  });

  it("自反：同 id 的在飞条目被跳过（重试 / 重入不被自己挡住）", () => {
    const decision = checkWritePathsExclusive(writeTask("task-a", ["src"]), [
      writeTask("task-a", ["src"]),
      writeTask("task-b", ["docs"]),
    ]);
    expect(decision).toEqual({ canRunInParallel: true });
  });

  it("在飞集为空 → 恒可并行（首轮）", () => {
    expect(checkWritePathsExclusive(writeTask("task-a", ["**"]), [])).toEqual({
      canRunInParallel: true,
    });
  });

  it("glob 保守判定进入拒绝原因（提示收窄模式可解除）", () => {
    const decision = checkWritePathsExclusive(writeTask("task-a", ["src/*.ts"]), [
      writeTask("task-b", ["src/*.md"]),
    ]);
    expect(decision.canRunInParallel).toBe(false);
    if (decision.canRunInParallel) {
      return;
    }
    expect(decision.conflicts[0]).toMatchObject({ relation: "may-overlap" });
    expect(decision.conflicts[0]?.reason).toContain("无法证明不相交");
  });
});

describe("在飞轮次表（ActiveTurnTable）", () => {
  function record(
    overrides: Partial<ActiveTurnRecord> & { readonly turnId: string },
  ): ActiveTurnRecord {
    return {
      sessionId: "sess-1" as LocalSessionId,
      role: "worker" as Role,
      writePaths: ["src"],
      startedAt: 100 as EpochMillis,
      ...overrides,
    };
  }

  it("登记 / 注销为不可变操作：原表不变，注销对不存在的 turnId 幂等", () => {
    const one = registerActiveTurn(EMPTY_ACTIVE_TURN_TABLE, record({ turnId: "t1" }));
    const two = registerActiveTurn(one, record({ turnId: "t2", startedAt: 200 as EpochMillis }));
    expect(EMPTY_ACTIVE_TURN_TABLE.size).toBe(0);
    expect(one.size).toBe(1);
    expect(two.size).toBe(2);

    const afterRemove = unregisterActiveTurn(two, "t1");
    expect(afterRemove.size).toBe(1);
    expect(two.size).toBe(2);
    // 幂等：注销不存在的轮返回原表（同一引用，无副本开销）
    expect(unregisterActiveTurn(afterRemove, "t1")).toBe(afterRemove);
  });

  it("重复登记同 turnId 抛错（编排 bug 快速失败）", () => {
    const one = registerActiveTurn(EMPTY_ACTIVE_TURN_TABLE, record({ turnId: "t1" }));
    expect(() => registerActiveTurn(one, record({ turnId: "t1" }))).toThrow(/已在飞/);
  });

  it("listActiveTurns 按 startedAt 升序", () => {
    let table = registerActiveTurn(
      EMPTY_ACTIVE_TURN_TABLE,
      record({ turnId: "late", startedAt: 300 as EpochMillis }),
    );
    table = registerActiveTurn(table, record({ turnId: "early", startedAt: 100 as EpochMillis }));
    expect(listActiveTurns(table).map((r) => r.turnId)).toEqual(["early", "late"]);
  });

  it("checkTurnParallelism：writePaths 相交拒绝、拒绝原因用 taskId（有任务时）", () => {
    const table = registerActiveTurn(
      EMPTY_ACTIVE_TURN_TABLE,
      record({ turnId: "t1", taskId: "task-b" as TaskId, writePaths: ["src/app"] }),
    );
    const decision = checkTurnParallelism(table, {
      turnId: "t2",
      taskId: "task-a" as TaskId,
      writePaths: ["src/app"],
    });
    expect(decision.canRunInParallel).toBe(false);
    if (decision.canRunInParallel) {
      return;
    }
    expect(decision.conflicts[0]).toMatchObject({
      candidateId: "task-a",
      inflightId: "task-b",
      relation: "identical",
    });
  });

  it("checkTurnParallelism：不相交可并行；空 writePaths 的 Planner 轮与任何轮可并行", () => {
    const table = registerActiveTurn(
      EMPTY_ACTIVE_TURN_TABLE,
      record({ turnId: "t1", writePaths: ["src/app"] }),
    );
    expect(checkTurnParallelism(table, { turnId: "t2", writePaths: ["docs"] })).toEqual({
      canRunInParallel: true,
    });
    expect(checkTurnParallelism(table, { turnId: "t3", writePaths: [] })).toEqual({
      canRunInParallel: true,
    });
  });

  it("checkTurnParallelism 自反：候选与同 turnId 的在飞记录不互斥", () => {
    const table = registerActiveTurn(
      EMPTY_ACTIVE_TURN_TABLE,
      record({ turnId: "t1", writePaths: ["src"] }),
    );
    expect(checkTurnParallelism(table, { turnId: "t1", writePaths: ["src"] })).toEqual({
      canRunInParallel: true,
    });
  });

  it("无任务的轮（Planner）在拒绝原因里以 turnId 出现", () => {
    const table = registerActiveTurn(
      EMPTY_ACTIVE_TURN_TABLE,
      // 假想形态：无 taskId 但有写范围（当前角色默认不会出现，形状允许则如实处理）
      record({ turnId: "turn-x", writePaths: ["src"] }),
    );
    const decision = checkTurnParallelism(table, { turnId: "t2", writePaths: ["src"] });
    expect(decision.canRunInParallel).toBe(false);
    if (decision.canRunInParallel) {
      return;
    }
    expect(decision.conflicts[0]?.inflightId).toBe("turn-x");
    expect(decision.conflicts[0]?.reason).toContain("turn-x");
  });
});
