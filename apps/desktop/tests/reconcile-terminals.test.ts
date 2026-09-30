/**
 * PTY 对账纯函数单测（T10.2'）。
 */

import type { ProjectId, ProjectWorkbenchLayout } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { leafPane } from "../src/shared/workbench/pane-tree";
import { planTerminalReconcile } from "../src/shared/workbench/reconcile-terminals";

function layoutWithWindows(
  projectId: string,
  windows: ReadonlyArray<{ readonly id: string; readonly terminalId?: string }>,
): ProjectWorkbenchLayout {
  const windowMap: Record<string, ProjectWorkbenchLayout["windows"][string]> = {};
  for (const window of windows) {
    windowMap[window.id] = {
      id: window.id,
      projectId: projectId as ProjectId,
      title: window.id,
      kind: "shell",
      cwd: "/tmp",
      createdAt: 1,
      ...(window.terminalId === undefined ? {} : { terminalId: window.terminalId }),
    };
  }
  const first = windows[0];
  return {
    projectId: projectId as ProjectId,
    tabs: first === undefined ? [] : [{ id: "tab-1", title: "Tab 1", root: leafPane(first.id) }],
    activeTabId: first === undefined ? null : "tab-1",
    windows: windowMap,
    maximizedWindowId: null,
    focusedWindowId: first?.id ?? null,
  };
}

describe("planTerminalReconcile", () => {
  it("布局有窗且 PTY 带 windowId → 挂回；无布局孤儿 → 杀", () => {
    const layouts = {
      p1: layoutWithWindows("p1", [{ id: "win-a", terminalId: "old-dead" }]),
    };
    const plan = planTerminalReconcile(layouts, [
      {
        id: "pty-alive",
        exited: false,
        metadata: { windowId: "win-a", projectId: "p1" },
      },
      {
        id: "pty-orphan",
        exited: false,
        metadata: { windowId: "ghost", projectId: "p1" },
      },
      {
        id: "pty-no-meta",
        exited: false,
      },
    ]);
    expect(plan.reattach).toEqual([
      { windowId: "win-a", projectId: "p1", terminalId: "pty-alive" },
    ]);
    expect(plan.orphanTerminalIds).toEqual(["pty-orphan"]);
    expect(plan.clearBindings).toEqual([]);
  });

  it("布局 terminalId 已死且无存活挂回 → clearBindings", () => {
    const layouts = {
      p1: layoutWithWindows("p1", [{ id: "win-a", terminalId: "dead-pty" }]),
    };
    const plan = planTerminalReconcile(layouts, [
      { id: "other", exited: false, metadata: { windowId: "other-win", projectId: "p1" } },
    ]);
    expect(plan.reattach).toEqual([]);
    expect(plan.orphanTerminalIds).toEqual(["other"]);
    expect(plan.clearBindings).toEqual([{ projectId: "p1", windowId: "win-a" }]);
  });

  it("projectId 不匹配 → 当孤儿", () => {
    const layouts = {
      p1: layoutWithWindows("p1", [{ id: "win-a" }]),
    };
    const plan = planTerminalReconcile(layouts, [
      {
        id: "pty-wrong-project",
        exited: false,
        metadata: { windowId: "win-a", projectId: "p2" },
      },
    ]);
    expect(plan.reattach).toEqual([]);
    expect(plan.orphanTerminalIds).toEqual(["pty-wrong-project"]);
  });
});
