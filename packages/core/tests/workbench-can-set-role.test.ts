/**
 * T10.6：canSetRole 穷举。
 * 用户可设任意窗口；窗口自设 manager 仅限用户开启的顶层窗口；窗口可设定后代；其余拒绝。
 */

import type { WorkbenchAuthActor, WorkbenchAuthNode } from "@ff-pane/core";
import { canSetRole } from "@ff-pane/core";
import { WORKBENCH_ROLES, type WorkbenchRole } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";

function node(
  id: string,
  openedBy: WorkbenchAuthNode["openedBy"],
  parentWindowId?: string,
): WorkbenchAuthNode {
  return {
    id,
    permission: "edit",
    openedBy,
    ...(parentWindowId !== undefined ? { parentWindowId } : {}),
  };
}

const tree: Record<string, WorkbenchAuthNode> = {
  userTop: node("userTop", "user"),
  child: node("child", { windowId: "userTop" }, "userTop"),
  grand: node("grand", { windowId: "child" }, "child"),
  sibling: node("sibling", { windowId: "userTop" }, "userTop"),
  windowTop: node("windowTop", { windowId: "someone" }),
  userNested: node("userNested", "user", "userTop"),
  outsider: node("outsider", "user"),
  closedChild: {
    ...node("closedChild", { windowId: "userTop" }, "userTop"),
    parentClosed: true,
  },
  cycleA: node("cycleA", "user", "cycleB"),
  cycleB: node("cycleB", "user", "cycleA"),
};

const windowActors = [
  "userTop",
  "child",
  "grand",
  "sibling",
  "windowTop",
  "userNested",
  "outsider",
  "closedChild",
  "cycleA",
  "cycleB",
] as const;

function expectSelf(actorId: string, role: WorkbenchRole): boolean {
  const info = tree[actorId];
  if (info === undefined) {
    return false;
  }
  const top = info.parentWindowId === undefined || info.parentWindowId.trim() === "";
  return role === "manager" && info.openedBy === "user" && top;
}

describe("canSetRole", () => {
  it("用户可设任意窗口的任意角色，包括树外窗口", () => {
    const targets = [...windowActors, "ghost"];
    for (const targetId of targets) {
      for (const role of WORKBENCH_ROLES) {
        expect(
          canSetRole({ kind: "user" }, { id: targetId, openedBy: "user" }, role, tree),
          `user → ${targetId} ${role}`,
        ).toBe(true);
      }
    }
  });

  it("窗口自设：仅用户开启的顶层窗口可设为 manager", () => {
    for (const actorId of windowActors) {
      for (const role of WORKBENCH_ROLES) {
        const actor: WorkbenchAuthActor = { kind: "window", windowId: actorId };
        expect(canSetRole(actor, { id: actorId }, role, tree), `${actorId} self ${role}`).toBe(
          expectSelf(actorId, role),
        );
      }
    }
  });

  it("窗口可设定全部后代的任意角色，不能设定非后代", () => {
    const descendants: Record<string, readonly string[]> = {
      userTop: ["child", "grand", "sibling", "userNested", "closedChild"],
      child: ["grand"],
      grand: [],
      sibling: [],
      windowTop: [],
      userNested: [],
      outsider: [],
      closedChild: [],
      cycleA: [],
      cycleB: [],
    };
    for (const actorId of windowActors) {
      const actor: WorkbenchAuthActor = { kind: "window", windowId: actorId };
      for (const targetId of windowActors) {
        if (targetId === actorId) {
          continue;
        }
        const allowed = descendants[actorId]?.includes(targetId) ?? false;
        for (const role of WORKBENCH_ROLES) {
          expect(
            canSetRole(actor, { id: targetId }, role, tree),
            `${actorId} → ${targetId} ${role}`,
          ).toBe(allowed);
        }
      }
    }
  });

  it("冷启动清洗锁住的窗口不能自设管理者，界面用户仍可以", () => {
    const locked: WorkbenchAuthNode = {
      ...node("locked", "user"),
      sanitizeLocked: true,
      parentClosed: true,
    };
    const lockedTree = { ...tree, locked };
    expect(
      canSetRole({ kind: "window", windowId: "locked" }, { id: "locked" }, "manager", lockedTree),
    ).toBe(false);
    expect(canSetRole({ kind: "user" }, { id: "locked" }, "manager", lockedTree)).toBe(true);
    expect(
      canSetRole({ kind: "window", windowId: "userTop" }, { id: "locked" }, "worker", lockedTree),
    ).toBe(false);
  });

  it("父已关闭但仍有 parentWindowId 时，不能自设为管理者", () => {
    expect(
      canSetRole(
        { kind: "window", windowId: "closedChild" },
        { id: "closedChild" },
        "manager",
        tree,
      ),
    ).toBe(false);
    expect(
      canSetRole({ kind: "window", windowId: "userTop" }, { id: "closedChild" }, "worker", tree),
    ).toBe(true);
  });

  it("树里的父级优先于调用方传入的 parent", () => {
    expect(
      canSetRole(
        { kind: "window", windowId: "userNested" },
        { id: "userNested", openedBy: "user" },
        "manager",
        tree,
      ),
    ).toBe(false);
  });

  it("空白父级视为顶层", () => {
    const blank: Record<string, WorkbenchAuthNode> = {
      top: { id: "top", permission: "edit", openedBy: "user", parentWindowId: "   " },
    };
    expect(canSetRole({ kind: "window", windowId: "top" }, { id: "top" }, "manager", blank)).toBe(
      true,
    );
  });

  it("非法角色、空 id、空 actor 一律拒绝", () => {
    expect(canSetRole({ kind: "user" }, { id: "userTop" }, "boss" as WorkbenchRole, tree)).toBe(
      false,
    );
    expect(canSetRole({ kind: "user" }, { id: "  " }, "manager", tree)).toBe(false);
    expect(canSetRole({ kind: "window", windowId: "  " }, { id: "userTop" }, "worker", tree)).toBe(
      false,
    );
    expect(
      canSetRole(
        { kind: "nope" } as unknown as WorkbenchAuthActor,
        { id: "userTop" },
        "manager",
        tree,
      ),
    ).toBe(false);
  });
});
