/**
 * T11.22：现任管理者与待命管理者。
 */

import { describe, expect, it } from "vitest";
import {
  authorize,
  controlsWindow,
  isStandbyManager,
  reportRedirectTarget,
  standbyManagerIds,
  type WorkbenchAuthNode,
} from "../src/workbench-permission/index.js";

function node(id: string, extras: Partial<WorkbenchAuthNode> = {}): WorkbenchAuthNode {
  return {
    id,
    permission: "edit-exec",
    openedBy: extras.parentWindowId !== undefined ? { windowId: extras.parentWindowId } : "user",
    ...extras,
  };
}

/** 现任 B；待命 A（standbyOf B）；A 名下执行 W1；无关的顶层执行 X。 */
function tree(): Record<string, WorkbenchAuthNode> {
  return {
    B: node("B", { role: "manager" }),
    A: node("A", { role: "manager", standbyOf: "B" }),
    W1: node("W1", { role: "worker", parentWindowId: "A" }),
    X: node("X", { role: "worker" }),
  };
}

describe("controlsWindow", () => {
  it("现任视同待命管理者和它整个后代的上级", () => {
    const t = tree();
    expect(controlsWindow("B", "A", t)).toBe(true);
    expect(controlsWindow("B", "W1", t)).toBe(true);
  });

  it("自己不管自己，待命的不能管现任，现任管不到无关窗口", () => {
    const t = tree();
    expect(controlsWindow("B", "B", t)).toBe(false);
    expect(controlsWindow("A", "B", t)).toBe(false);
    expect(controlsWindow("B", "X", t)).toBe(false);
  });

  it("待命管理者仍管自己名下的后代（真祖先）", () => {
    expect(controlsWindow("A", "W1", tree())).toBe(true);
  });

  it("非管理者角色不因 standbyOf 获得控制权", () => {
    const t = {
      ...tree(),
      Z: node("Z", { role: "worker" }),
      K: node("K", { role: "manager", standbyOf: "Z" }),
    };
    expect(controlsWindow("Z", "K", t)).toBe(false);
  });

  it("待命标记查询", () => {
    const t = tree();
    expect(standbyManagerIds("B", t)).toEqual(["A"]);
    expect(isStandbyManager("A", t)).toBe(true);
    expect(isStandbyManager("B", t)).toBe(false);
  });
});

describe("authorize 对现任放宽", () => {
  const actor = { kind: "window", windowId: "B" } as const;

  it("现任可对旧管理者的执行发消息、读输出、关闭", () => {
    const t = tree();
    for (const action of ["send-message", "read-output", "close"] as const) {
      expect(authorize({ actor, action, targetWindowId: "W1", tree: t }).ok, action).toBe(true);
    }
  });

  it("现任改权限不得超过自己", () => {
    const t = tree();
    expect(
      authorize({
        actor,
        action: "adjust-permission",
        targetWindowId: "W1",
        newPermission: "edit",
        tree: t,
      }).ok,
    ).toBe(true);
    const denied = authorize({
      actor,
      action: "adjust-permission",
      targetWindowId: "W1",
      newPermission: "yolo",
      tree: t,
    });
    expect(denied).toEqual({ ok: false, reason: "exceeds-caller-ceiling" });
  });

  it("待命管理者对现任仍然没有控制权", () => {
    const denied = authorize({
      actor: { kind: "window", windowId: "A" },
      action: "send-message",
      targetWindowId: "B",
      tree: tree(),
    });
    expect(denied.ok).toBe(false);
  });

  it("现任管不到无关的顶层窗口", () => {
    expect(authorize({ actor, action: "close", targetWindowId: "X", tree: tree() }).ok).toBe(false);
  });

  it("执行仍可向待命的上级汇报", () => {
    expect(
      authorize({
        actor: { kind: "window", windowId: "W1" },
        action: "report",
        targetWindowId: "A",
        tree: tree(),
      }).ok,
    ).toBe(true);
  });
});

describe("reportRedirectTarget", () => {
  it("目标是待命管理者时改送现任，其余原样", () => {
    const t = tree();
    expect(reportRedirectTarget("A", t)).toBe("B");
    expect(reportRedirectTarget("B", t)).toBe("B");
    expect(reportRedirectTarget("X", t)).toBe("X");
  });

  it("现任已不在树里时不改道", () => {
    const t = tree();
    delete t["B"];
    expect(reportRedirectTarget("A", t)).toBe("A");
  });
});
