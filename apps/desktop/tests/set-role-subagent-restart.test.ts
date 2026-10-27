/**
 * T11.1：运行中改角色，能不能开子 agent 变了（普通 ↔ 其他角色）就重启窗口；没变就照旧投一行说明。
 */

import type { ProjectId, ProjectWorkbenchLayout, WorkbenchRole } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import type { IdleDeliverQueue } from "../src/main/workbench/idle-deliver";
import { setWindowRole } from "../src/main/workbench/set-role";

const projectId = "proj-1" as ProjectId;

function layoutWith(
  role: WorkbenchRole,
  kind: "claude" | "codex" | "grok",
): ProjectWorkbenchLayout {
  return {
    projectId,
    tabs: [{ id: "tab-1", title: "Tab", slots: ["w", null, null, null, null, null] }],
    activeTabId: "tab-1",
    windows: {
      w: {
        id: "w",
        projectId,
        title: "窗口",
        kind,
        cwd: "C:/p",
        createdAt: 1,
        permission: "edit",
        openedBy: "user",
        role,
      },
    },
    maximizedWindowId: null,
    focusedWindowId: "w",
  };
}

function setup(
  role: WorkbenchRole,
  options: {
    readonly kind?: "claude" | "codex" | "grok";
    readonly running?: boolean;
    readonly restart?: "restarting" | "queued" | "confirm" | "deferred";
  } = {},
) {
  let layout = layoutWith(role, options.kind ?? "claude");
  const restarts: string[] = [];
  const delivered: string[] = [];
  const deps = {
    authRegistry: createWorkbenchAuthRegistry(),
    readLayouts: async () => ({ [projectId]: layout }),
    saveLayout: async (next: ProjectWorkbenchLayout) => {
      layout = next;
    },
    findLiveTerminalId: () => (options.running === false ? undefined : "pty-1"),
    idleQueue: {
      enqueue: (item: { text: string }) => {
        delivered.push(item.text);
        return { status: "delivered" };
      },
    } as unknown as IdleDeliverQueue,
    manualPath: async () => "manual.md",
    restartForPolicy: async (windowId: string) => {
      restarts.push(windowId);
      return options.restart ?? "restarting";
    },
  };
  return { deps, restarts, delivered, layout: () => layout };
}

describe("改角色时的子 agent 限制", () => {
  it("普通改成管理者：重启生效，不往终端里打那一行", async () => {
    const { deps, restarts, delivered, layout } = setup("none");
    const result = await setWindowRole({ kind: "user" }, "w", "manager", deps);
    expect(result).toMatchObject({ ok: true, role: "manager", delivery: "restarting" });
    expect(restarts).toEqual(["w"]);
    expect(delivered).toEqual([]);
    expect(layout().windows["w"]?.role).toBe("manager");
  });

  it("管理者改回普通也要重启；在忙就排队", async () => {
    const { deps, restarts } = setup("manager", { restart: "queued" });
    const result = await setWindowRole({ kind: "user" }, "w", "none", deps);
    expect(result).toMatchObject({ ok: true, delivery: "restart-queued" });
    expect(restarts).toEqual(["w"]);
  });

  it("执行改成管理者：限制没变，不重启，照旧投一行说明", async () => {
    const { deps, restarts, delivered } = setup("worker");
    const result = await setWindowRole({ kind: "user" }, "w", "manager", deps);
    expect(result).toMatchObject({ ok: true, delivery: "delivered" });
    expect(restarts).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  it("现在没法重启（deferred）就照旧投说明，下次启动生效", async () => {
    const { deps, restarts, delivered } = setup("none", { restart: "deferred" });
    const result = await setWindowRole({ kind: "user" }, "w", "worker", deps);
    expect(result).toMatchObject({ ok: true, delivery: "delivered" });
    expect(restarts).toEqual(["w"]);
    expect(delivered).toHaveLength(1);
  });

  it("没在运行、或是 Grok 窗口：不重启", async () => {
    const stopped = setup("none", { running: false });
    expect(await setWindowRole({ kind: "user" }, "w", "manager", stopped.deps)).toMatchObject({
      ok: true,
      delivery: "skipped",
    });
    expect(stopped.restarts).toEqual([]);
    const grok = setup("none", { kind: "grok" });
    await setWindowRole({ kind: "user" }, "w", "manager", grok.deps);
    expect(grok.restarts).toEqual([]);
  });
});
