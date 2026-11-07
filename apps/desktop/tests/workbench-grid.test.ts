/**
 * T11.2d：工作台按个数自动排——放置、加在窗口后面、关窗往前挤、排法、位置、分隔线、比例。
 */

import type { ProjectId, ProjectWorkbenchLayout, WorkbenchWindow } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  detachWindowFromLayout,
  GRID_MIN_FRACTION,
  gridCellRects,
  gridDividers,
  gridLines,
  gridSizesFor,
  normalizeSlots,
  orientationFor,
  placeOpenedWindow,
  placeUserWindow,
  resetGridSizes,
  resizePair,
  slotLine,
  withCellSizes,
  withLineSizes,
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

function openUser(layout: ProjectWorkbenchLayout, id: string, afterWindowId?: string) {
  return placeUserWindow(
    layout,
    win(id),
    nextTab(),
    afterWindowId !== undefined ? { afterWindowId } : undefined,
  );
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

describe("新窗口放哪", () => {
  it("依次加到末尾，第 7 个开新页并切过去", () => {
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

  it("标签栏的「＋」：开新页", () => {
    let layout = openUser(empty(), "w1");
    layout = placeUserWindow(layout, win("w2"), nextTab(), { newPage: true });
    expect(layout.tabs).toHaveLength(2);
    expect(layout.tabs[1]?.slots[0]).toBe("w2");
  });

  it("窗口上的「加一个窗口」：加在那个窗口后面，后面的往后挪", () => {
    let layout = openUser(empty(), "a");
    layout = openUser(layout, "b");
    layout = openUser(layout, "c", "a");
    expect(layout.tabs[0]?.slots).toEqual(["a", "c", "b", null, null, null]);
    expect(layout.focusedWindowId).toBe("c");
  });

  it("「加一个窗口」时那页满了：开新页", () => {
    let layout = empty();
    for (let i = 1; i <= 6; i += 1) {
      layout = openUser(layout, `w${i}`);
    }
    layout = openUser(layout, "x", "w2");
    expect(layout.tabs).toHaveLength(2);
    expect(layout.tabs[1]?.slots[0]).toBe("x");
  });

  it("个数变了就丢掉拖过的比例", () => {
    let layout = openUser(openUser(empty(), "a"), "b");
    const tab = layout.tabs[0];
    if (tab === undefined) {
      throw new Error("no tab");
    }
    layout = {
      ...layout,
      tabs: [{ ...tab, sizes: withCellSizes(undefined, "landscape", 2, 0, [0.7, 0.3]) }],
    };
    layout = openUser(layout, "c");
    expect(layout.tabs[0]?.sizes).toBeUndefined();
  });
});

describe("关窗", () => {
  it("后面的往前挤；整页关空就去掉这页", () => {
    let layout = empty();
    for (const id of ["a", "b", "c", "d", "e"]) {
      layout = openUser(layout, id);
    }
    layout = detachWindowFromLayout(layout, "b");
    expect(layout.tabs[0]?.slots).toEqual(["a", "c", "d", "e", null, null]);
    for (const id of ["a", "c", "d", "e"]) {
      layout = detachWindowFromLayout(layout, id);
    }
    expect(layout.tabs).toHaveLength(0);
    expect(layout.activeTabId).toBeNull();
  });

  it("旧档里中间有空格的也挤紧", () => {
    expect(normalizeSlots([null, "a", null, "b", "a"])).toEqual(["a", "b", null, null, null, null]);
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
    expect(layout.tabs).toHaveLength(3);
    expect(layout.tabs[1]?.slots).toEqual(["c6", "c7", "c8", "c9", "c10", "c11"]);
    expect(layout.tabs[1]?.teamOf).toBe("mgr");
    expect(layout.tabs[1]?.title).toBe("团队：mgr");
    expect(layout.tabs[2]?.slots).toEqual(["c12", null, null, null, null, null]);
    expect(layout.activeTabId).toBe(userTab);
    expect(layout.focusedWindowId).toBe("mgr");
  });

  it("团队页里关掉一个，再开的子窗口加到那页末尾", () => {
    let layout = openUser(empty(), "mgr");
    for (let i = 1; i <= 8; i += 1) {
      layout = placeOpenedWindow(layout, "mgr", win(`c${i}`, "mgr"), nextTab());
    }
    layout = detachWindowFromLayout(layout, "c7");
    layout = placeOpenedWindow(layout, "mgr", win("c9", "mgr"), nextTab());
    expect(layout.tabs[1]?.slots).toEqual(["c6", "c8", "c9", null, null, null]);
  });

  it("关掉管理者：它的子窗口标记 parentClosed，往前挤", () => {
    let layout = openUser(empty(), "mgr");
    layout = placeOpenedWindow(layout, "mgr", win("c1", "mgr"), nextTab());
    layout = detachWindowFromLayout(layout, "mgr");
    expect(layout.windows["c1"]?.parentClosed).toBe(true);
    expect(layout.tabs[0]?.slots).toEqual(["c1", null, null, null, null, null]);
  });
});

describe("按个数排", () => {
  it("每条线几个：1、2、3、2+2、3+2、3+3", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => gridLines(n))).toEqual([
      [1],
      [2],
      [3],
      [2, 2],
      [3, 2],
      [3, 3],
    ]);
    expect(gridLines(0)).toEqual([]);
    expect(slotLine(5, 3)).toEqual({ line: 1, cell: 0 });
    expect(slotLine(5, 2)).toEqual({ line: 0, cell: 2 });
  });

  it("横向 5 个：上 3 下 2，各自均分", () => {
    const rects = gridCellRects(5, "landscape", gridSizesFor(undefined, "landscape", 5));
    expect(rects).toHaveLength(5);
    expect(rects[0]).toEqual({ left: 0, top: 0, width: 1 / 3, height: 0.5 });
    expect(close(rects[2]?.left ?? 0, 2 / 3)).toBe(true);
    expect(rects[3]).toEqual({ left: 0, top: 0.5, width: 0.5, height: 0.5 });
    expect(rects[4]).toEqual({ left: 0.5, top: 0.5, width: 0.5, height: 0.5 });
  });

  it("竖向转 90°：2 个上下，5 个左 3 右 2", () => {
    const two = gridCellRects(2, "portrait", gridSizesFor(undefined, "portrait", 2));
    expect(two).toEqual([
      { left: 0, top: 0, width: 1, height: 0.5 },
      { left: 0, top: 0.5, width: 1, height: 0.5 },
    ]);
    const five = gridCellRects(5, "portrait", gridSizesFor(undefined, "portrait", 5));
    expect(five[0]).toEqual({ left: 0, top: 0, width: 0.5, height: 1 / 3 });
    expect(five[3]).toEqual({ left: 0.5, top: 0, width: 0.5, height: 0.5 });
  });

  it("1 个占满", () => {
    expect(gridCellRects(1, "landscape", gridSizesFor(undefined, "landscape", 1))).toEqual([
      { left: 0, top: 0, width: 1, height: 1 },
    ]);
    expect(gridDividers(1, "landscape", gridSizesFor(undefined, "landscape", 1))).toEqual([]);
  });

  it("分隔线：横向 5 个有 1 条横线、上面 2 条竖线、下面 1 条竖线", () => {
    const dividers = gridDividers(5, "landscape", gridSizesFor(undefined, "landscape", 5));
    expect(dividers.filter((d) => d.kind === "line")).toEqual([
      { kind: "line", line: 1, index: 1, at: 0.5, from: 0, to: 1, vertical: false },
    ]);
    const cells = dividers.filter((d) => d.kind === "cell");
    expect(cells.map((d) => [d.line, d.index, d.vertical, d.from, d.to])).toEqual([
      [0, 1, true, 0, 0.5],
      [0, 2, true, 0, 0.5],
      [1, 1, true, 0.5, 1],
    ]);
  });

  it("竖向时分隔线方向反过来", () => {
    const dividers = gridDividers(4, "portrait", gridSizesFor(undefined, "portrait", 4));
    expect(dividers.find((d) => d.kind === "line")?.vertical).toBe(true);
    expect(dividers.filter((d) => d.kind === "cell").every((d) => !d.vertical)).toBe(true);
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

  it("没调过均分；改一条线里的格子只动这条线；横竖分开存；恢复均分", () => {
    const even = gridSizesFor(undefined, "landscape", 5);
    expect(even.lines).toEqual([0.5, 0.5]);
    expect(even.cells[0]).toHaveLength(3);
    expect(even.cells[1]).toHaveLength(2);
    let sizes = withCellSizes(undefined, "landscape", 5, 0, [0.5, 0.25, 0.25]);
    sizes = withLineSizes(sizes, "landscape", 5, [0.7, 0.3]);
    const landscape = gridSizesFor(sizes, "landscape", 5);
    expect(landscape.cells[0]).toEqual([0.5, 0.25, 0.25]);
    expect(landscape.cells[1]).toEqual([0.5, 0.5]);
    expect(landscape.lines).toEqual([0.7, 0.3]);
    expect(gridSizesFor(sizes, "portrait", 5).lines).toEqual([0.5, 0.5]);
    expect(resetGridSizes(sizes, "landscape")).toBeUndefined();
  });

  it("存的比例和个数对不上：均分", () => {
    const sizes = withCellSizes(undefined, "landscape", 3, 0, [0.6, 0.2, 0.2]);
    expect(gridSizesFor(sizes, "landscape", 2).cells[0]).toEqual([0.5, 0.5]);
  });

  it("拖分隔线只改相邻两份，不小于最小占比", () => {
    const moved = resizePair([0.5, 0.25, 0.25], 1, 0.1);
    expect(moved[0]).toBeCloseTo(0.6);
    expect(moved[1]).toBeCloseTo(0.15);
    expect(moved[2]).toBe(0.25);
    const squeezed = resizePair([0.5, 0.5], 1, 0.9);
    expect(squeezed[0]).toBeCloseTo(1 - GRID_MIN_FRACTION);
    expect(squeezed[1]).toBeCloseTo(GRID_MIN_FRACTION);
    expect(resizePair([0.5, 0.5], 1, -0.9)[0]).toBeCloseTo(GRID_MIN_FRACTION);
    expect(resizePair([0.5, 0.5], 0, 0.1)).toEqual([0.5, 0.5]);
  });
});
