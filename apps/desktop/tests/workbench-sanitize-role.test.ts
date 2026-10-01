/**
 * T10.9：冷启动清洗锁住的窗口不能经 MCP 自设管理者。
 */

import type { ProjectId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import type { IdleDeliverQueue } from "../src/main/workbench/idle-deliver";
import { setWindowRole } from "../src/main/workbench/set-role";

const projectId = "proj-1" as ProjectId;

function deps(registry: ReturnType<typeof createWorkbenchAuthRegistry>) {
  return {
    authRegistry: registry,
    readLayouts: async () => ({}),
    saveLayout: async () => undefined,
    findLiveTerminalId: () => undefined,
    idleQueue: { enqueue: () => ({ kind: "skipped" }) } as unknown as IdleDeliverQueue,
    manualPath: async () => "manual.md",
  };
}

describe("setWindowRole 与清洗锁", () => {
  it("窗口自设 manager 被拒绝，且不记 userRoleSet、不授予管理权", async () => {
    const registry = createWorkbenchAuthRegistry();
    registry.upsert(
      {
        id: "locked",
        permission: "edit",
        role: "worker",
        openedBy: "user",
        sanitizeLocked: true,
        parentClosed: true,
      },
      projectId,
    );
    const result = await setWindowRole(
      { kind: "window", windowId: "locked" },
      "locked",
      "manager",
      deps(registry),
    );
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(registry.get("locked")?.role).toBe("worker");
    expect(registry.get("locked")?.userRoleSet).toBeUndefined();
    expect(registry.isManagerGranted("locked")).toBe(false);
  });

  it("界面用户可以把同一窗口设回管理者并授予管理权", async () => {
    const registry = createWorkbenchAuthRegistry();
    registry.upsert(
      {
        id: "locked",
        permission: "edit",
        role: "worker",
        openedBy: "user",
        sanitizeLocked: true,
        parentClosed: true,
      },
      projectId,
    );
    const result = await setWindowRole({ kind: "user" }, "locked", "manager", deps(registry));
    expect(result.ok).toBe(true);
    expect(registry.get("locked")?.role).toBe("manager");
    expect(registry.get("locked")?.userRoleSet).toBe(true);
    expect(registry.isManagerGranted("locked")).toBe(true);
  });
});
