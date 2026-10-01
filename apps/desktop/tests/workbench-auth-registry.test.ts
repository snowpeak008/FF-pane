/**
 * T10.5'：权威权限注册表 — 忽略伪造父级、启动封顶。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectWorkbenchLayout } from "@ff-pane/shared";
import { createWorkbenchLayoutStore } from "@ff-pane/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import { decideManagerGrantRestore } from "../src/main/workbench/manager-grant";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

  it("首次同步采用布局角色，之后 setRole 不被陈旧布局覆盖", () => {
    const registry = createWorkbenchAuthRegistry();
    const window = {
      id: "w",
      projectId: "proj-1" as never,
      title: "W",
      kind: "claude" as const,
      cwd: "D:\\x",
      createdAt: 0,
      profileId: "p",
      permission: "edit" as const,
      openedBy: "user" as const,
      role: "worker" as const,
    };
    const first = registry.syncLayout(layoutWith({ w: window }));
    expect(first.windows["w"]?.role).toBe("worker");
    expect(registry.get("w")?.role).toBe("worker");
    expect(registry.setRole("w", "manager")).toBe(true);
    const again = registry.syncLayout(layoutWith({ w: window }));
    expect(again.windows["w"]?.role).toBe("manager");
    expect(registry.get("w")?.role).toBe("manager");
  });

  it("冷启动按磁盘父子封顶，手改的 yolo 不能当成顶层授权", () => {
    const registry = createWorkbenchAuthRegistry();
    const restored = registry.restoreColdLayout(
      layoutWith({
        parent: win("parent", { permission: "edit", role: "manager" }),
        child: win("child", {
          permission: "yolo",
          role: "worker",
          parentWindowId: "parent",
          openedBy: { windowId: "parent" },
        }),
      }),
    );
    expect(restored.windows["child"]?.parentWindowId).toBe("parent");
    expect(restored.windows["child"]?.permission).toBe("edit");
    expect(restored.windows["child"]?.permissionNeedsDowngrade).toBe(true);
    expect(registry.isManagerGranted("parent")).toBe(false);
    expect(registry.isManagerGranted("child")).toBe(false);
  });

  it("冷读的子管理者只显示待恢复，不授予开窗口", () => {
    const registry = createWorkbenchAuthRegistry();
    const restored = registry.restoreColdLayout(
      layoutWith({
        parent: win("parent", { permission: "edit", role: "manager" }),
        child: win("child", {
          permission: "edit",
          role: "manager",
          parentWindowId: "parent",
          openedBy: { windowId: "parent" },
          managerGrantPending: true,
        }),
      }),
    );
    expect(registry.isManagerGranted("child")).toBe(false);
    expect(registry.isManagerGranted("parent")).toBe(false);
    expect(restored.windows["child"]?.managerGrantPending).toBe(true);
    expect(restored.windows["parent"]?.managerGrantPending).toBeUndefined();
  });

  it("冷启动成环后断开父级并降为只读", () => {
    const registry = createWorkbenchAuthRegistry();
    const restored = registry.restoreColdLayout(
      layoutWith({
        A: win("A", { permission: "yolo", parentWindowId: "B", openedBy: "user" }),
        B: win("B", { permission: "yolo", parentWindowId: "A", openedBy: "user" }),
      }),
    );
    expect(restored.windows["A"]?.parentWindowId).toBeUndefined();
    expect(restored.windows["B"]?.parentWindowId).toBeUndefined();
    expect(restored.windows["A"]?.parentClosed).toBe(true);
    expect(restored.windows["B"]?.parentClosed).toBe(true);
    expect(restored.windows["A"]?.permission).toBe("read-only");
    expect(restored.windows["B"]?.permission).toBe("read-only");
    expect(registry.get("A")?.parentWindowId).toBeUndefined();
  });

  it("冷启动：没有父级且不是用户开启，降为只读，启动不采用请求值", () => {
    const registry = createWorkbenchAuthRegistry();
    const restored = registry.restoreColdLayout(
      layoutWith({
        child: win("child", {
          permission: "yolo",
          openedBy: { windowId: "gone" },
        }),
      }),
    );
    expect(restored.windows["child"]?.permission).toBe("read-only");
    expect(restored.windows["child"]?.parentWindowId).toBeUndefined();
    expect(registry.get("child")?.sanitizeLocked).toBe(true);
    expect(registry.resolveLaunch("child", "yolo")).toEqual({
      effective: "read-only",
      capped: true,
      cycle: false,
    });
  });

  it("冷启动：父级 id 不在树上且不是用户开启，同样只读", () => {
    const registry = createWorkbenchAuthRegistry();
    const restored = registry.restoreColdLayout(
      layoutWith({
        child: win("child", {
          permission: "yolo",
          parentWindowId: "missing",
          openedBy: { windowId: "missing" },
        }),
      }),
    );
    expect(restored.windows["child"]?.permission).toBe("read-only");
    expect(registry.resolveLaunch("child", "yolo").effective).toBe("read-only");
  });

  it("用户开启且没有父级的 yolo 冷启动保持 yolo", () => {
    const registry = createWorkbenchAuthRegistry();
    const restored = registry.restoreColdLayout(
      layoutWith({
        top: win("top", { permission: "yolo", role: "manager" }),
      }),
    );
    expect(restored.windows["top"]?.permission).toBe("yolo");
    expect(registry.resolveLaunch("top", "yolo").effective).toBe("yolo");
    expect(
      decideManagerGrantRestore({
        role: "manager",
        openedBy: "user",
        parentGranted: false,
        alreadyGranted: false,
        sanitizeLocked: registry.get("top")?.sanitizeLocked === true,
      }),
    ).toBe("user-reauth");
  });

  it("成环清洗后重复 syncLayout 不得用磁盘 yolo 或 openedBy=user 抬回来", () => {
    const registry = createWorkbenchAuthRegistry();
    const disk = layoutWith({
      A: win("A", { permission: "yolo", role: "manager", parentWindowId: "B", openedBy: "user" }),
      B: win("B", { permission: "yolo", role: "manager", parentWindowId: "A", openedBy: "user" }),
    });
    registry.restoreColdLayout(disk);
    const again = registry.syncLayout(disk);
    const third = registry.syncLayout(disk);
    for (const cleaned of [again, third]) {
      expect(cleaned.windows["A"]?.permission).toBe("read-only");
      expect(cleaned.windows["A"]?.parentWindowId).toBeUndefined();
      expect(cleaned.windows["B"]?.permission).toBe("read-only");
    }
    expect(registry.get("A")?.openedBy).toBe("user");
    expect(registry.isManagerGranted("A")).toBe(false);
    expect(
      decideManagerGrantRestore({
        role: "manager",
        openedBy: registry.get("A")?.openedBy ?? "user",
        parentGranted: false,
        alreadyGranted: false,
        sanitizeLocked: registry.get("A")?.sanitizeLocked === true,
      }),
    ).toBe("none");
  });

  it("父级缺失后，磁盘把 openedBy 改成 user 也不能覆盖注册表", () => {
    const registry = createWorkbenchAuthRegistry();
    const first = layoutWith({
      child: win("child", {
        permission: "yolo",
        parentWindowId: "missing",
        openedBy: { windowId: "missing" },
      }),
    });
    registry.restoreColdLayout(first);
    const forged = layoutWith({
      child: win("child", { permission: "yolo", openedBy: "user", role: "manager" }),
    });
    const again = registry.syncLayout(forged);
    expect(again.windows["child"]?.permission).toBe("read-only");
    expect(again.windows["child"]?.openedBy).toEqual({ windowId: "missing" });
    expect(registry.resolveLaunch("child", "yolo").effective).toBe("read-only");
    expect(
      decideManagerGrantRestore({
        role: "manager",
        openedBy: registry.get("child")?.openedBy ?? "user",
        parentGranted: false,
        alreadyGranted: false,
        sanitizeLocked: true,
      }),
    ).toBe("none");
  });

  it("冷启动和再次同步都留下连法、覆盖和对话历史", async () => {
    const registry = createWorkbenchAuthRegistry();
    const disk = layoutWith({
      child: win("child", {
        permission: "edit",
        role: "worker",
        routeMode: "relay",
        routeProviderName: "中转甲",
        routeModel: "from-config",
        routeEffort: "low",
        modelOverride: "opus",
        effortOverride: "high",
        nativeSessionId: "sess-current",
        sessionUnidentified: true,
        conversations: [
          { id: "sess-old", startedAt: 1, lastActiveAt: 2 },
          { id: "sess-current", startedAt: 3, lastActiveAt: 4 },
        ],
      }),
    });
    const restored = registry.restoreColdLayout(disk);
    const cold = restored.windows["child"];
    expect(cold?.routeMode).toBe("relay");
    expect(cold?.routeProviderName).toBe("中转甲");
    expect(cold?.routeModel).toBe("from-config");
    expect(cold?.routeEffort).toBe("low");
    expect(cold?.modelOverride).toBe("opus");
    expect(cold?.effortOverride).toBe("high");
    expect(cold?.nativeSessionId).toBe("sess-current");
    expect(cold?.sessionUnidentified).toBe(true);
    expect(cold?.conversations?.map((item) => item.id)).toEqual(["sess-old", "sess-current"]);
    expect(cold?.profileId).toBeUndefined();
    expect(cold?.permission).toBe("edit");

    const again = registry.syncLayout(restored);
    expect(again.windows["child"]?.modelOverride).toBe("opus");
    expect(again.windows["child"]?.effortOverride).toBe("high");
    expect(again.windows["child"]?.conversations).toHaveLength(2);
    expect(again.windows["child"]?.routeMode).toBe("relay");

    const root = await mkdtemp(join(tmpdir(), "ffpane-auth-layout-"));
    tempRoots.push(root);
    const store = createWorkbenchLayoutStore(join(root, "layouts.json"));
    await store.saveProject(restored);
    const reread = await store.readProject("proj-1" as never);
    const saved = reread?.windows["child"];
    expect(saved?.modelOverride).toBe("opus");
    expect(saved?.effortOverride).toBe("high");
    expect(saved?.conversations?.map((item) => item.id)).toEqual(["sess-old", "sess-current"]);
    expect(saved?.sessionUnidentified).toBe(true);
    expect(saved?.routeMode).toBe("relay");
    expect(saved?.profileId).toBeUndefined();
  });

  it("界面显式改权限后可以提升，未调用则重复同步仍是只读", () => {
    const registry = createWorkbenchAuthRegistry();
    const disk = layoutWith({
      child: win("child", {
        permission: "yolo",
        openedBy: { windowId: "gone" },
      }),
    });
    registry.restoreColdLayout(disk);
    expect(registry.syncLayout(disk).windows["child"]?.permission).toBe("read-only");
    expect(registry.applyUserPermission("child", "edit")).toBe(true);
    expect(registry.get("child")?.sanitizeLocked).toBeUndefined();
    const raised = registry.syncLayout(disk);
    expect(raised.windows["child"]?.permission).toBe("edit");
    expect(registry.resolveLaunch("child", "yolo").effective).toBe("edit");
  });
});

function win(
  id: string,
  patch: Partial<ProjectWorkbenchLayout["windows"][string]>,
): ProjectWorkbenchLayout["windows"][string] {
  return {
    id,
    projectId: "proj-1" as never,
    title: id,
    kind: "claude",
    cwd: "D:\\x",
    createdAt: 0,
    permission: "edit",
    openedBy: "user",
    role: "none",
    profileId: "p1",
    ...patch,
  };
}
