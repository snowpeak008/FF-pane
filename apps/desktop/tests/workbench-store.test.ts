/**
 * workbench store 单测（T10.2'）：创建 / 分屏 / 关闭 / dropProject / flush 防抖。
 */

import type { ProjectId } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saves: unknown[] = [];
const kills: string[] = [];
const listedTerminals: Array<{
  id: string;
  exited: boolean;
  metadata?: Record<string, string>;
}> = [];

vi.mock("../src/renderer/src/ipc/query", () => ({
  invokeQuery: vi.fn(async (channel: string, request?: unknown) => {
    if (channel === "workbench:get-layouts") {
      return { status: "success", data: {}, refreshing: false };
    }
    if (channel === "workbench:save-layout") {
      saves.push(request);
      return { status: "success", data: { ok: true }, refreshing: false };
    }
    if (channel === "terminal:kill") {
      const id = (request as { id: string }).id;
      kills.push(id);
      return { status: "success", data: { ok: true }, refreshing: false };
    }
    if (channel === "terminal:list") {
      return { status: "success", data: listedTerminals, refreshing: false };
    }
    return { status: "error", error: { message: `unexpected ${channel}` }, retrying: false };
  }),
}));

import { clearLiveTerminalsForTests } from "../src/renderer/src/pages/workbench/live-terminals";
import {
  flushWorkbenchLayouts,
  resetWorkbenchStoreForTests,
  useWorkbenchStore,
} from "../src/renderer/src/stores/workbench";

const PROJECT = "proj-1" as ProjectId;

describe("workbench store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saves.length = 0;
    kills.length = 0;
    listedTerminals.length = 0;
    resetWorkbenchStoreForTests();
    clearLiveTerminalsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetWorkbenchStoreForTests();
    clearLiveTerminalsForTests();
  });

  it("createTabWithWindow / splitWindow / closeWindow 维护树与计数", async () => {
    const store = useWorkbenchStore.getState();
    const created = store.createTabWithWindow({
      projectId: PROJECT,
      projectRoot: "D:/tmp/p",
      title: "Shell 1",
    });
    expect(created.ok).toBe(true);
    expect(store.countRunningWindows()).toBe(1);

    const split = useWorkbenchStore.getState().splitWindow({
      projectId: PROJECT,
      projectRoot: "D:/tmp/p",
      targetWindowId: created.windowId,
      direction: "horizontal",
    });
    expect(split.ok).toBe(true);
    expect(useWorkbenchStore.getState().countRunningWindows()).toBe(2);

    const layout = useWorkbenchStore.getState().getProjectLayout(PROJECT);
    expect(layout.tabs).toHaveLength(1);
    expect(layout.tabs[0]?.root.type).toBe("split");

    await useWorkbenchStore.getState().closeWindow(PROJECT, created.windowId);
    expect(useWorkbenchStore.getState().countRunningWindows()).toBe(1);
    const after = useWorkbenchStore.getState().getProjectLayout(PROJECT);
    expect(after.tabs[0]?.root).toEqual({
      type: "leaf",
      windowId: split.ok ? split.windowId : "",
    });
  });

  it("防抖 persist；flushWorkbenchLayouts 立刻落盘", async () => {
    useWorkbenchStore.getState().createTabWithWindow({
      projectId: PROJECT,
      projectRoot: "D:/tmp/p",
    });
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(399);
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toHaveLength(1);

    const windowId = Object.keys(useWorkbenchStore.getState().getProjectLayout(PROJECT).windows)[0];
    expect(windowId).toBeTruthy();
    if (windowId === undefined) {
      return;
    }
    useWorkbenchStore.getState().renameWindow(PROJECT, windowId, "Renamed Now");
    expect(saves).toHaveLength(1);
    await flushWorkbenchLayouts();
    expect(saves).toHaveLength(2);
    const last = saves[1] as { layout: { windows: Record<string, { title: string }> } };
    const titles = Object.values(last.layout.windows).map((w) => w.title);
    expect(titles).toContain("Renamed Now");
  });

  it("dropProject 清除幽灵布局，不再占上限额度", () => {
    useWorkbenchStore.getState().createTabWithWindow({
      projectId: PROJECT,
      projectRoot: "D:/tmp/p",
    });
    useWorkbenchStore.getState().createTabWithWindow({
      projectId: "proj-2" as ProjectId,
      projectRoot: "D:/tmp/p2",
    });
    expect(useWorkbenchStore.getState().countRunningWindows()).toBe(2);
    useWorkbenchStore.getState().dropProject(PROJECT);
    expect(useWorkbenchStore.getState().countRunningWindows()).toBe(1);
    expect(useWorkbenchStore.getState().layoutsByProject[PROJECT]).toBeUndefined();
  });

  it("hydrate 对账：挂回存活 PTY、杀掉孤儿", async () => {
    listedTerminals.push(
      {
        id: "pty-keep",
        exited: false,
        metadata: { windowId: "win-keep", projectId: PROJECT },
      },
      {
        id: "pty-orphan",
        exited: false,
        metadata: { windowId: "win-gone", projectId: PROJECT },
      },
    );

    const { invokeQuery } = await import("../src/renderer/src/ipc/query");
    const mockInvoke = vi.mocked(invokeQuery) as unknown as {
      mockImplementation: (fn: (channel: string, request?: unknown) => Promise<unknown>) => void;
    };
    mockInvoke.mockImplementation(async (channel, request) => {
      if (channel === "workbench:get-layouts") {
        return {
          status: "success",
          data: {
            [PROJECT]: {
              projectId: PROJECT,
              tabs: [{ id: "tab-1", title: "Tab 1", root: { type: "leaf", windowId: "win-keep" } }],
              activeTabId: "tab-1",
              windows: {
                "win-keep": {
                  id: "win-keep",
                  projectId: PROJECT,
                  title: "Shell",
                  kind: "shell",
                  cwd: "/tmp",
                  createdAt: 1,
                },
              },
              maximizedWindowId: null,
              focusedWindowId: "win-keep",
            },
          },
          refreshing: false,
        };
      }
      if (channel === "terminal:list") {
        return { status: "success", data: listedTerminals, refreshing: false };
      }
      if (channel === "terminal:kill") {
        kills.push((request as { id: string }).id);
        return { status: "success", data: { ok: true }, refreshing: false };
      }
      return { status: "success", data: { ok: true }, refreshing: false };
    });

    resetWorkbenchStoreForTests();
    await useWorkbenchStore.getState().hydrate();
    expect(kills).toContain("pty-orphan");
    const layout = useWorkbenchStore.getState().getProjectLayout(PROJECT);
    expect(layout.windows["win-keep"]?.terminalId).toBe("pty-keep");
  });
});
