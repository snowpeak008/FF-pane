/**
 * T11.2b：工作台固定 6 格的放置、分屏、关窗、方向、比例。
 */

import type { ProjectId, ProjectWorkbenchLayout, WorkbenchWindow } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  detachWindowFromLayout,
  emptySlotBelow,
  emptySlotRightOf,
  gridSizesFor,
  orientationFor,
  placeOpenedWindow,
  placeSplitWindow,
  placeUserWindow,
  resetGridSizes,
  slotPosition,
  withColSizes,
  withRowSizes,
} from "../src/shared/workbench/grid";

const P = "proj" as ProjectId;

function win(id: string, parentWindowId?: string): WorkbenchWindow {
  return {
    id,
    projectId: P,
    title: id,
    kind: "shell",
    cwd: "C:/p",
    createdAt: 1,
    ...(parentWindowId !== undefined ? { parentWindowId } : {}),
  };
}

function empty(): ProjectWorkbenchLayout {
  return {
    projectId: P,
    tabs: [],
    activeTabId: null,
    windows: {},
    maximizedWindowId: null,
    focusedWindowId: null,
  };
}

let tabCounter = 0;
function nextTab(): string {
  tabCounter += 1;
  return `tab-${tabCounter}`;
}

function openUser(layout: ProjectWorkbenchLayout, id: string, slot?: number) {
  return placeUserWindow(layout, win(id), nextTab(), slot !== undefined ? { slot } : undefined);
}

describe("新窗口放哪", () => {
  it("依次落到 1–6 格，第 7 个开新页并切过去", () => {
    let layout = empty();
    for (let i = 1; i <= 7; i += 1) {
      layout = openUser(layout, `w${i}`);
    }
    expect(layout.tabs).toHaveLength(2);
    expect(layout.tabs[0]?.slots).toEqual(["w1", "w2", "w3", "w4", "w5", "w6"]);
    expect(layout.tabs[1]?.slots).toEqual(["w7", null, null, null, null, null]);
    expect(layout.activeTabId).toBe(layout.tabs[1]?.id);
    expect(layout.focusedWindowId).toBe("w7");
  });

  it("关掉第 2 格，那格变空、别的不动；再开落回第 2 格；点空格子就放那格", () => {
    let layout = empty();
    for (let i = 1; i <= 4; i += 1) {
      layout = openUser(layout, `w${i}`);
    }
    layout = detachWindowFromLayout(layout, "w2");
    expect(layout.tabs[0]?.slots).toEqual(["w1", null, "w3", "w4", null, null]);
    layout = openUser(layout, "w5");
    expect(layout.tabs[0]?.slots).toEqual(["w1", "w5", "w3", "w4", null, null]);
    layout = openUser(layout, "w6", 5);
    expect(layout.tabs[0]?.slots).toEqual(["w1", "w5", "w3", "w4", null, "w6"]);
  });

  it("标签栏的「＋」（新建标签）：当前页有空格也开新页", () => {
    let layout = openUser(empty(), "w1");
    layout = placeUserWindow(layout, win("w2"), nextTab(), { newPage: true });
    expect(layout.tabs).toHaveLength(2);
    expect(layout.tabs[1]?.slots[0]).toBe("w2");
    expect(layout.activeTabId).toBe(layout.tabs[1]?.id);
  });

  it("一页的窗口都关了，这页就去掉", () => {
    let layout = openUser(empty(), "w1");
    layout = detachWindowFromLayout(layout, "w1");
    expect(layout.tabs).toEqual([]);
    expect(layout.activeTabId).toBeNull();
  });
});

describe("分屏", () => {
  it("向右落到同一行右边最近的空格；在最右一格开新页", () => {
    let layout = openUser(empty(), "a");
    layout = placeSplitWindow(layout, "a", win("b"), "right", "landscape", nextTab()) ?? layout;
    expect(layout.tabs[0]?.slots).toEqual(["a", "b", null, null, null, null]);
    layout = placeSplitWindow(layout, "a", win("c"), "right", "landscape", nextTab()) ?? layout;
    expect(layout.tabs[0]?.slots).toEqual(["a", "b", "c", null, null, null]);
    layout = placeSplitWindow(layout, "c", win("d"), "right", "landscape", nextTab()) ?? layout;
    expect(layout.tabs).toHaveLength(2);
    expect(layout.tabs[1]?.slots[0]).toBe("d");
  });

  it("向下落到同一列下面；竖向是 2 列 × 3 行", () => {
    let layout = openUser(empty(), "a");
    layout = placeSplitWindow(layout, "a", win("b"), "down", "landscape", nextTab()) ?? layout;
    expect(layout.tabs[0]?.slots).toEqual(["a", null, null, "b", null, null]);
    let portrait = openUser(empty(), "a");
    portrait = placeSplitWindow(portrait, "a", win("b"), "down", "portrait", nextTab()) ?? portrait;
    portrait = placeSplitWindow(portrait, "b", win("c"), "down", "portrait", nextTab()) ?? portrait;
    expect(portrait.tabs[0]?.slots).toEqual(["a", null, "b", null, "c", null]);
    portrait = placeSplitWindow(portrait, "c", win("d"), "down", "portrait", nextTab()) ?? portrait;
    expect(portrait.tabs).toHaveLength(2);
  });

  it("格子位置和找空格", () => {
    expect(slotPosition(4, "landscape")).toEqual({ row: 1, col: 1 });
    expect(slotPosition(4, "portrait")).toEqual({ row: 2, col: 0 });
    const slots = ["a", "b", null, null, "e", null];
    expect(emptySlotRightOf(slots, 0, "landscape")).toBe(2);
    expect(emptySlotRightOf(slots, 2, "landscape")).toBe(-1);
    expect(emptySlotBelow(slots, 0, "landscape")).toBe(3);
    expect(emptySlotBelow(slots, 1, "landscape")).toBe(-1);
  });
});

describe("管理者开子窗口", () => {
  it("先填管理者那页，再填它已有的团队页，都满了才开新团队页；不切页", () => {
    let layout = openUser(empty(), "mgr");
    const userTab = layout.activeTabId;
    for (let i = 1; i <= 5; i += 1) {
      layout = placeOpenedWindow(layout, "mgr", win(`c${i}`, "mgr"), nextTab());
    }
    expect(layout.tabs).toHaveLength(1);
    expect(layout.tabs[0]?.slots).toEqual(["mgr", "c1", "c2", "c3", "c4", "c5"]);
    for (let i = 6; i <= 12; i += 1) {
      layout = placeOpenedWindow(layout, "mgr", win(`c${i}`, "mgr"), nextTab());
    }
    // 第 6–11 个进同一个团队页，第 12 个才开第二个团队页；不会一个窗口一页。
    expect(layout.tabs).toHaveLength(3);
    expect(layout.tabs[1]?.slots).toEqual(["c6", "c7", "c8", "c9", "c10", "c11"]);
    expect(layout.tabs[1]?.teamOf).toBe("mgr");
    expect(layout.tabs[1]?.title).toBe("团队：mgr");
    expect(layout.tabs[2]?.slots).toEqual(["c12", null, null, null, null, null]);
    expect(layout.activeTabId).toBe(userTab);
    expect(layout.focusedWindowId).toBe("mgr");
  });

  it("团队页里关掉一个，再开的子窗口落进那个空格", () => {
    let layout = openUser(empty(), "mgr");
    for (let i = 1; i <= 8; i += 1) {
      layout = placeOpenedWindow(layout, "mgr", win(`c${i}`, "mgr"), nextTab());
    }
    layout = detachWindowFromLayout(layout, "c7");
    layout = placeOpenedWindow(layout, "mgr", win("c9", "mgr"), nextTab());
    expect(layout.tabs[1]?.slots).toEqual(["c6", "c9", "c8", null, null, null]);
  });

  it("关掉管理者：它的子窗口标记 parentClosed", () => {
    let layout = openUser(empty(), "mgr");
    layout = placeOpenedWindow(layout, "mgr", win("c1", "mgr"), nextTab());
    layout = detachWindowFromLayout(layout, "mgr");
    expect(layout.windows["c1"]?.parentClosed).toBe(true);
    expect(layout.tabs[0]?.slots).toEqual([null, "c1", null, null, null, null]);
  });
});

describe("方向和比例", () => {
  it("宽高比在 0.9–1.1 之间不换方向", () => {
    expect(orientationFor(1600, 900, "portrait")).toBe("landscape");
    expect(orientationFor(800, 1200, "landscape")).toBe("portrait");
    expect(orientationFor(1000, 1000, "portrait")).toBe("portrait");
    expect(orientationFor(1050, 1000, "landscape")).toBe("landscape");
    expect(orientationFor(0, 0, "landscape")).toBe("landscape");
  });

  it("没调过均分；改一行只动这一行；横竖分开存；恢复均分", () => {
    const even = gridSizesFor(undefined, "landscape");
    expect(even.rows).toEqual([0.5, 0.5]);
    expect(even.cols[0]).toHaveLength(3);
    let sizes = withColSizes(undefined, "landscape", 0, [0.5, 0.25, 0.25]);
    sizes = withRowSizes(sizes, "landscape", [0.7, 0.3]);
    const landscape = gridSizesFor(sizes, "landscape");
    expect(landscape.cols[0]).toEqual([0.5, 0.25, 0.25]);
    expect(landscape.cols[1]?.every((value) => Math.abs(value - 1 / 3) < 1e-9)).toBe(true);
    expect(landscape.rows).toEqual([0.7, 0.3]);
    expect(gridSizesFor(sizes, "portrait").rows).toHaveLength(3);
    expect(resetGridSizes(sizes, "landscape")).toBeUndefined();
  });
});
