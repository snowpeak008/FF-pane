/**
 * T11.22：管理者接任、待命、复位。任何时刻至多一个窗口被授予管理权。
 */

import { describe, expect, it } from "vitest";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";

const PROJECT = "proj-1" as never;

function registryWith(ids: readonly string[]) {
  const registry = createWorkbenchAuthRegistry();
  for (const id of ids) {
    registry.upsert({ id, permission: "edit-exec", openedBy: "user", role: "manager" }, PROJECT);
  }
  return registry;
}

function grantedCount(registry: ReturnType<typeof registryWith>, ids: readonly string[]): number {
  return ids.filter((id) => registry.isManagerGranted(id)).length;
}

describe("管理者接任", () => {
  it("新顶层管理者接任，旧现任转待命但保留角色和权限", () => {
    const registry = registryWith(["A", "B"]);
    expect(registry.grantManager("A")).toEqual([]);
    expect(registry.grantManager("B")).toEqual(["A"]);
    expect(registry.isManagerGranted("A")).toBe(false);
    expect(registry.isManagerGranted("B")).toBe(true);
    expect(registry.get("A")?.standbyOf).toBe("B");
    expect(registry.get("A")?.role).toBe("manager");
    expect(registry.get("A")?.permission).toBe("edit-exec");
    expect(registry.get("B")?.standbyOf).toBeUndefined();
  });

  it("任何时刻至多一个被授予", () => {
    const ids = ["A", "B", "C"];
    const registry = registryWith(ids);
    for (const id of ["A", "B", "C", "A", "C"]) {
      registry.grantManager(id);
      expect(grantedCount(registry, ids)).toBe(1);
      expect(registry.isManagerGranted(id)).toBe(true);
    }
  });

  it("原有待命的改指新现任", () => {
    const registry = registryWith(["A", "B", "C"]);
    registry.grantManager("A");
    registry.grantManager("B");
    expect(registry.grantManager("C")).toEqual(["B"]);
    expect(registry.get("A")?.standbyOf).toBe("C");
    expect(registry.get("B")?.standbyOf).toBe("C");
  });

  it("有父级的子管理者继承授权，不接任", () => {
    const registry = registryWith(["B"]);
    registry.upsert(
      {
        id: "C",
        permission: "edit",
        openedBy: { windowId: "B" },
        parentWindowId: "B",
        role: "manager",
      },
      PROJECT,
    );
    registry.grantManager("B");
    expect(registry.grantManager("C")).toEqual([]);
    expect(registry.isManagerGranted("B")).toBe(true);
    expect(registry.isManagerGranted("C")).toBe(true);
    expect(registry.get("B")?.standbyOf).toBeUndefined();
  });

  it("别的项目的管理者不受影响", () => {
    const registry = registryWith(["A"]);
    registry.upsert(
      { id: "Z", permission: "edit-exec", openedBy: "user", role: "manager" },
      "proj-2" as never,
    );
    registry.grantManager("A");
    expect(registry.grantManager("Z")).toEqual([]);
    expect(registry.isManagerGranted("A")).toBe(true);
  });
});

describe("待命与复位", () => {
  it("改成非管理者角色时清掉待命标记", () => {
    const registry = registryWith(["A", "B"]);
    registry.grantManager("A");
    registry.grantManager("B");
    registry.clearManagerGrant("A");
    expect(registry.get("A")?.standbyOf).toBeUndefined();
  });

  it("现任关掉后，待命的重新授予即复位为现任", () => {
    const registry = registryWith(["A", "B"]);
    registry.grantManager("A");
    registry.grantManager("B");
    registry.closeRegistered("B");
    expect(registry.isManagerGranted("B")).toBe(false);
    expect(registry.grantManager("A")).toEqual([]);
    expect(registry.isManagerGranted("A")).toBe(true);
    expect(registry.get("A")?.standbyOf).toBeUndefined();
  });

  it("界面存布局后待命标记不丢", () => {
    const registry = registryWith(["A", "B"]);
    registry.grantManager("A");
    registry.grantManager("B");
    const base = { projectId: PROJECT, cwd: "D:\\x", createdAt: 0, profileId: "p" };
    registry.syncLayout({
      projectId: PROJECT,
      tabs: [{ id: "t", title: "T", slots: ["A", "B", null, null, null, null] }],
      activeTabId: "t",
      windows: {
        A: {
          ...base,
          id: "A",
          title: "A",
          kind: "claude",
          permission: "edit-exec",
          openedBy: "user",
          role: "manager",
        },
        B: {
          ...base,
          id: "B",
          title: "B",
          kind: "claude",
          permission: "edit-exec",
          openedBy: "user",
          role: "manager",
        },
      },
      maximizedWindowId: null,
      focusedWindowId: "A",
    } as never);
    expect(registry.get("A")?.standbyOf).toBe("B");
    expect(registry.isManagerGranted("B")).toBe(true);
  });
});
