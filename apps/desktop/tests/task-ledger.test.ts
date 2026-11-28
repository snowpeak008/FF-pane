/**
 * T11.24：任务账本纯逻辑。状态转换、完成条件、管理者排序、父子汇总、重合查找。
 */

import { describe, expect, it } from "vitest";
import {
  applyTransition,
  canTransition,
  findOverlapping,
  isTaskOpen,
  type LedgerTask,
  overlapScore,
  rollupParentStatus,
  sortForManager,
} from "../src/main/workbench/task-ledger";

function task(over: Partial<LedgerTask> = {}): LedgerTask {
  return {
    id: "t-1",
    title: "修沉船链",
    detail: "查船跑约55秒触发沉船链的原因",
    acceptance: "给出原因",
    status: "todo",
    createdAt: 1,
    updatedAt: 1,
    createdBy: { windowId: "w1", title: "管理者", role: "manager" },
    events: [],
    ...over,
  };
}

describe("状态转换", () => {
  it("done 和 cancelled 是终点，failed 还能回到 todo", () => {
    expect(canTransition("done", "doing")).toBe(false);
    expect(canTransition("cancelled", "todo")).toBe(false);
    expect(canTransition("failed", "todo")).toBe(true);
    expect(canTransition("todo", "done")).toBe(false);
  });

  it("failed 算未完成，done 和 cancelled 才算结束", () => {
    expect(isTaskOpen("failed")).toBe(true);
    expect(isTaskOpen("submitted")).toBe(true);
    expect(isTaskOpen("done")).toBe(false);
    expect(isTaskOpen("cancelled")).toBe(false);
  });

  it("改状态会在时间线追加一行并刷新 updatedAt", () => {
    const result = applyTransition(task(), "doing", "w2", "开始做", 50);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.status).toBe("doing");
      expect(result.task.updatedAt).toBe(50);
      expect(result.task.events).toHaveLength(1);
      expect(result.task.events[0]).toMatchObject({ from: "todo", to: "doing", by: "w2" });
    }
  });

  it("不合法的转换被拒绝并说明原因", () => {
    const result = applyTransition(task(), "done", "w1", "", 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("todo");
    }
  });
});

describe("标完成的条件", () => {
  const submitted = task({ status: "submitted" });

  it("没有结论不能完成", () => {
    expect(applyTransition(submitted, "done", "w1", "", 2).ok).toBe(false);
  });

  it("结论是返工不能完成", () => {
    const result = applyTransition(submitted, "done", "w1", "", 2, {
      result: "rework",
      reason: "没覆盖第二点",
    });
    expect(result.ok).toBe(false);
  });

  it("免检必须写理由", () => {
    expect(
      applyTransition(submitted, "done", "w1", "", 2, { result: "waived", reason: "  " }).ok,
    ).toBe(false);
    expect(
      applyTransition(submitted, "done", "w1", "", 2, { result: "waived", reason: "只是查个进度" })
        .ok,
    ).toBe(true);
  });

  it("通过的结论可以完成并记在任务上", () => {
    const result = applyTransition(submitted, "done", "w1", "验收通过", 3, {
      result: "pass",
      reason: "对照验收标准都满足",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.verdict?.result).toBe("pass");
      expect(result.task.status).toBe("done");
    }
  });
});

describe("管理者排序", () => {
  it("failed、blocked、submitted、rework、doing、todo 依次排前，同级更新得早的在前", () => {
    const sorted = sortForManager([
      task({ id: "a", status: "todo", updatedAt: 1 }),
      task({ id: "b", status: "doing", updatedAt: 5 }),
      task({ id: "c", status: "failed", updatedAt: 9 }),
      task({ id: "d", status: "submitted", updatedAt: 3 }),
      task({ id: "e", status: "blocked", updatedAt: 2 }),
      task({ id: "f", status: "doing", updatedAt: 4 }),
      task({ id: "g", status: "rework", updatedAt: 6 }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["c", "e", "d", "g", "f", "b", "a"]);
  });
});

describe("父任务由子任务汇总", () => {
  it("没有子任务返回空，取消的不算", () => {
    expect(rollupParentStatus([])).toBeUndefined();
    expect(rollupParentStatus([task({ status: "cancelled" })])).toBeUndefined();
  });

  it("有失败 → failed，有卡住 → blocked", () => {
    expect(
      rollupParentStatus([task({ status: "done" }), task({ id: "x", status: "failed" })]),
    ).toBe("failed");
    expect(
      rollupParentStatus([task({ status: "doing" }), task({ id: "x", status: "blocked" })]),
    ).toBe("blocked");
  });

  it("全部 done → submitted，全部 todo → todo，其余 → doing", () => {
    expect(rollupParentStatus([task({ status: "done" }), task({ id: "x", status: "done" })])).toBe(
      "submitted",
    );
    expect(rollupParentStatus([task({ status: "todo" }), task({ id: "x", status: "todo" })])).toBe(
      "todo",
    );
    expect(rollupParentStatus([task({ status: "done" }), task({ id: "x", status: "todo" })])).toBe(
      "doing",
    );
    // 取消的子任务不拖后腿
    expect(
      rollupParentStatus([task({ status: "done" }), task({ id: "x", status: "cancelled" })]),
    ).toBe("submitted");
  });
});

describe("重合查找", () => {
  it("同主题的未完成大任务能找到", () => {
    const found = findOverlapping([task()], "查船跑沉船链原因", "船跑约55秒触发沉船链");
    expect(found.map((item) => item.id)).toEqual(["t-1"]);
    expect(
      overlapScore(
        "查船跑沉船链原因 船跑约55秒触发沉船链",
        "修沉船链 查船跑约55秒触发沉船链的原因",
      ),
    ).toBeGreaterThan(0.5);
  });

  it("不相干的不算重合", () => {
    expect(findOverlapping([task()], "给贴花加发光分档", "渲染收尾里的一项")).toEqual([]);
  });

  it("子任务和已结束的任务不参与", () => {
    const probeTitle = "查船跑沉船链原因";
    const probeDetail = "船跑约55秒触发沉船链";
    expect(findOverlapping([task({ parentId: "t-0" })], probeTitle, probeDetail)).toEqual([]);
    expect(findOverlapping([task({ status: "done" })], probeTitle, probeDetail)).toEqual([]);
    expect(findOverlapping([task({ status: "failed" })], probeTitle, probeDetail)).toHaveLength(1);
  });
});
