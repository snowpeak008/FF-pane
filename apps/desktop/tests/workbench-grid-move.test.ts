/**
 * T11.2c：拖窗口换位置——对调、移到别的标签、满了拒绝、拖到「＋」开新页。
 * T11.2d 起格子挤紧：没有空格可落，移走后原来那页往前挤。
 */

import type { ProjectId, ProjectWorkbenchLayout, WorkbenchTab } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  dropTargetOf,
  moveWindowInLayout,
  type WindowDropTarget,
} from "../src/shared/workbench/grid";

const P = "proj" as ProjectId;

function tab(id: string, slots: readonly (string | null)[], title = id): WorkbenchTab {
  return { id, title, slots: [...slots, null, null, null, null, null, null].slice(0, 6) };
}

function layoutOf(tabs: readonly WorkbenchTab[], activeTabId = tabs[0]?.id ?? null) {
  const ids = tabs.flatMap((item) => item.slots.filter((id): id is string => id !== null));
  const layout: ProjectWorkbenchLayout = {
    projectId: P,
    tabs: [...tabs],
    activeTabId,
    windows: Object.fromEntries(
      ids.map((id) => [
        id,
        { id, projectId: P, title: id, kind: "shell" as const, cwd: "C:/p", createdAt: 1 },
      ]),
    ),
    maximizedWindowId: null,
    focusedWindowId: ids[0] ?? null,
  };
  return layout;
}

function move(layout: ProjectWorkbenchLayout, windowId: string, target: WindowDropTarget) {
  return moveWindowInLayout(layout, windowId, target, "tab-new");
}

function moved(layout: ProjectWorkbenchLayout, windowId: string, target: WindowDropTarget) {
  const result = move(layout, windowId, target);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.layout;
}

describe("同一页里拖", () => {
  it("落到另一个窗口上两个对调，别的不动", () => {
    const layout = layoutOf([tab("t1", ["a", "b", "c"])]);
    const next = moved(layout, "a", { kind: "slot", tabId: "t1", slot: 2 });
    expect(next.tabs[0]?.slots).toEqual(["c", "b", "a", null, null, null]);
    expect(next.windows).toBe(layout.windows);
  });

  it("对调不改个数，拖过的比例留着", () => {
    const layout = layoutOf([{ ...tab("t1", ["a", "b"]), sizes: {} }]);
    expect(moved(layout, "a", { kind: "slot", tabId: "t1", slot: 1 }).tabs[0]?.sizes).toEqual({});
  });

  it("落回自己那格、落到空位置、或落到自己这页的标签上：不变", () => {
    const layout = layoutOf([tab("t1", ["a", "b"])]);
    expect(move(layout, "a", { kind: "slot", tabId: "t1", slot: 0 })).toEqual({
      ok: false,
      reason: "unchanged",
    });
    expect(move(layout, "a", { kind: "slot", tabId: "t1", slot: 5 })).toEqual({
      ok: false,
      reason: "unchanged",
    });
    expect(move(layout, "a", { kind: "tab", tabId: "t1" })).toEqual({
      ok: false,
      reason: "unchanged",
    });
  });
});

describe("拖到别的标签", () => {
  it("加到那一页末尾，原来那页往前挤，停在当前页", () => {
    const layout = layoutOf([tab("t1", ["a", "b", "c"]), tab("t2", ["x", "y"])]);
    const next = moved(layout, "a", { kind: "tab", tabId: "t2" });
    expect(next.tabs.map((item) => item.slots)).toEqual([
      ["b", "c", null, null, null, null],
      ["x", "y", "a", null, null, null],
    ]);
    expect(next.activeTabId).toBe("t1");
  });

  it("那一页满了不让放", () => {
    const layout = layoutOf([tab("t1", ["a"]), tab("t2", ["1", "2", "3", "4", "5", "6"])]);
    expect(move(layout, "a", { kind: "tab", tabId: "t2" })).toEqual({ ok: false, reason: "full" });
  });

  it("当前页拖空了就去掉，切到窗口去的那页", () => {
    const layout = layoutOf([tab("t1", ["a"]), tab("t2", ["x"])]);
    const next = moved(layout, "a", { kind: "tab", tabId: "t2" });
    expect(next.tabs.map((item) => item.id)).toEqual(["t2"]);
    expect(next.activeTabId).toBe("t2");
    expect(next.tabs[0]?.slots.slice(0, 2)).toEqual(["x", "a"]);
  });

  it("团队页的 teamOf 留着；两页个数都变了，拖过的比例都丢掉", () => {
    const team: WorkbenchTab = { ...tab("t2", ["x"]), teamOf: "m", sizes: {} };
    const layout = layoutOf([{ ...tab("t1", ["a", "b"]), sizes: {} }, team]);
    const next = moved(layout, "a", { kind: "tab", tabId: "t2" });
    expect(next.tabs[1]).toMatchObject({ teamOf: "m" });
    expect(next.tabs[1]?.sizes).toBeUndefined();
    expect(next.tabs[0]?.sizes).toBeUndefined();
  });
});

describe("拖到「＋」", () => {
  it("开新页放第 1 格，原来那页往前挤", () => {
    const layout = layoutOf([tab("t1", ["a", "b"], "Tab 1")]);
    const next = moved(layout, "b", { kind: "new-tab" });
    expect(next.tabs).toHaveLength(2);
    expect(next.tabs[1]).toMatchObject({ id: "tab-new", title: "Tab 2" });
    expect(next.tabs[1]?.slots[0]).toBe("b");
    expect(next.tabs[0]?.slots.slice(0, 2)).toEqual(["a", null]);
    expect(next.activeTabId).toBe("t1");
  });

  it("这页只有它一个：不变", () => {
    const layout = layoutOf([tab("t1", ["a"])]);
    expect(move(layout, "a", { kind: "new-tab" })).toEqual({ ok: false, reason: "unchanged" });
  });
});

it("最大化的窗口拖走后取消最大化", () => {
  const layout = { ...layoutOf([tab("t1", ["a", "b"]), tab("t2", [])]), maximizedWindowId: "a" };
  expect(moved(layout, "a", { kind: "tab", tabId: "t2" }).maximizedWindowId).toBeNull();
});

it("落点从 data-* 读出来", () => {
  expect(dropTargetOf({ drop: "slot", tabId: "t1", slot: "3" })).toEqual({
    kind: "slot",
    tabId: "t1",
    slot: 3,
  });
  expect(dropTargetOf({ drop: "tab", tabId: "t2" })).toEqual({ kind: "tab", tabId: "t2" });
  expect(dropTargetOf({ drop: "new-tab" })).toEqual({ kind: "new-tab" });
  expect(dropTargetOf({ drop: "slot", tabId: "t1" })).toBeNull();
  expect(dropTargetOf({})).toBeNull();
});
