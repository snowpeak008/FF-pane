/**
 * T11.7：干活中途插哪些消息、插正文还是只提一句、同一批不重复。
 */

import { describe, expect, it } from "vitest";
import { type MidTurnMessage, planMidTurnInbox } from "../src/main/workbench/mid-turn-inbox";

function above(id: string, sender = "管理者"): MidTurnMessage {
  return { id, fromAbove: true, sender };
}

function below(id: string, sender = "执行 1"): MidTurnMessage {
  return { id, fromAbove: false, sender };
}

describe("planMidTurnInbox", () => {
  it("没有未读、或只有下级的消息：不插", () => {
    expect(planMidTurnInbox([], undefined)).toEqual({ kind: "none" });
    expect(planMidTurnInbox([below("m1"), below("m2")], undefined)).toEqual({ kind: "none" });
  });

  it("未读全是上级或用户本人的：插正文", () => {
    expect(planMidTurnInbox([above("m1"), above("m2", "用户本人")], undefined)).toEqual({
      kind: "digest",
      announceId: "m2",
    });
  });

  it("夹着下级的：只提一句，说清谁发的、几条", () => {
    const plan = planMidTurnInbox([below("m1"), above("m2"), above("m3", "用户本人")], undefined);
    expect(plan.kind).toBe("notice");
    if (plan.kind !== "notice") {
      return;
    }
    expect(plan.announceId).toBe("m3");
    expect(plan.text).toContain("管理者、用户本人 发来的 2 条新消息");
    expect(plan.text).toContain("共 3 条未读");
  });

  it("同一批只说一次；来了新的再说", () => {
    const first = [below("m1"), above("m2")];
    expect(planMidTurnInbox(first, "m2")).toEqual({ kind: "none" });
    expect(planMidTurnInbox([...first, above("m4")], "m2").kind).toBe("notice");
    // 后来只多了下级的消息：不再说。
    expect(planMidTurnInbox([...first, below("m5")], "m2")).toEqual({ kind: "none" });
  });

  it("来源多了只列前 3 个", () => {
    const plan = planMidTurnInbox(
      [below("x"), above("a", "甲"), above("b", "乙"), above("c", "丙"), above("d", "丁")],
      undefined,
    );
    expect(plan.kind === "notice" && plan.text.includes("甲、乙、丙 等")).toBe(true);
  });
});
