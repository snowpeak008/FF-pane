/**
 * T10.5'：权威权限注册表 — 忽略伪造父级、启动封顶。
 */

import type { ProjectWorkbenchLayout } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";

function layoutWith(windows: ProjectWorkbenchLayout["windows"]): ProjectWorkbenchLayout {
  const ids = Object.keys(windows);
  return {
    projectId: "proj-1" as never,
    tabs: [
      {
        id: "tab-1",
        title: "Tab",
        root: { type: "leaf", windowId: ids[0] ?? "x" },
      },
    ],
    activeTabId: "tab-1",
    windows,
    maximizedWindowId: null,
    focusedWindowId: ids[0] ?? null,
  };
}

describe("createWorkbenchAuthRegistry", () => {
  it("忽略 renderer 伪造的 parentWindowId", () => {
    const registry = createWorkbenchAuthRegistry();
    const forged = layoutWith({
      child: {
        id: "child",
        projectId: "proj-1" as never,
        title: "C",
        kind: "claude",
        cwd: "D:\\x",
        createdAt: 0,
        permission: "yolo",
        openedBy: "user",
        parentWindowId: "forged-manager",
        profileId: "p1",
      },
    });
    const cleaned = registry.syncLayout(forged);
    expect(cleaned.windows["child"]?.parentWindowId).toBeUndefined();
    expect(cleaned.windows["child"]?.permission).toBe("yolo");
  });

  it("主进程 upsert 父级后 launch 封顶", () => {
    const registry = createWorkbenchAuthRegistry();
    registry.upsert({ id: "parent", permission: "edit", openedBy: "user" }, "proj-1" as never);
    registry.upsert(
      {
        id: "child",
        permission: "edit",
        openedBy: { windowId: "parent" },
        parentWindowId: "parent",
      },
      "proj-1" as never,
    );
    const launch = registry.resolveLaunch("child", "yolo");
    expect(launch.effective).toBe("edit");
    expect(launch.capped).toBe(true);
  });

  it("环布局读入后断开", () => {
    const registry = createWorkbenchAuthRegistry();
    registry.upsert(
      { id: "A", permission: "edit-exec", openedBy: "user", parentWindowId: "B" },
      "proj-1" as never,
    );
    registry.upsert(
      { id: "B", permission: "edit", openedBy: "user", parentWindowId: "A" },
      "proj-1" as never,
    );
    const dirty = layoutWith({
      A: {
        id: "A",
        projectId: "proj-1" as never,
        title: "A",
        kind: "claude",
        cwd: "D:\\x",
        createdAt: 0,
        permission: "yolo",
        openedBy: "user",
        parentWindowId: "B",
        profileId: "p1",
      },
      B: {
        id: "B",
        projectId: "proj-1" as never,
        title: "B",
        kind: "claude",
        cwd: "D:\\x",
        createdAt: 0,
        permission: "yolo",
        openedBy: "user",
        parentWindowId: "A",
        profileId: "p1",
      },
    });
    const cleaned = registry.syncLayout(dirty);
    expect(cleaned.windows["A"]?.permission).toBe("read-only");
    expect(cleaned.windows["B"]?.permission).toBe("read-only");
    expect(cleaned.windows["A"]?.parentWindowId).toBeUndefined();
    expect(cleaned.windows["B"]?.parentWindowId).toBeUndefined();
  });
});
