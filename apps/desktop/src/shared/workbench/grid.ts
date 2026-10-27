/**
 * 工作台固定格子（T11.2b，Tony 2026-10-24 / 10-27 定）。纯函数，只依赖 @ff-pane/shared 的类型。
 *
 * - 每页 6 格，编号 0–5。横向（宽 ≥ 高）3 列 × 2 行，竖向 2 列 × 3 行。换方向时编号不变，只是位置重排。
 * - 空格子留着，关掉一个窗口那格变空，别的不挪。
 * - 新窗口放当前页编号最小的空格；没有就开新页。
 * - 管理者开子窗口：先放管理者那页，再放这个管理者已有的团队页，都满了才开新的团队页。
 * - 向右 / 向下分屏：同一行右边 / 同一列下面最近的空格；没有就开新页。
 * - 拖分隔线：每一行是独立的一条，行里的竖线只改左右两格；行之间的横线只改这两行。
 */

import type {
  ProjectWorkbenchLayout,
  WorkbenchGridSizes,
  WorkbenchTab,
  WorkbenchWindow,
} from "@ff-pane/shared";

export const GRID_SLOTS = 6;

export type GridOrientation = "landscape" | "portrait";

export const GRID_SHAPE: Readonly<
  Record<GridOrientation, { readonly cols: number; readonly rows: number }>
> = {
  landscape: { cols: 3, rows: 2 },
  portrait: { cols: 2, rows: 3 },
};

export type GridSlots = readonly (string | null)[];

export function emptySlots(): (string | null)[] {
  return Array.from({ length: GRID_SLOTS }, () => null);
}

/** 补齐或截到 6 格；不认识的值当空格。 */
export function normalizeSlots(slots: readonly unknown[]): (string | null)[] {
  const out = emptySlots();
  for (let index = 0; index < GRID_SLOTS; index += 1) {
    const value = slots[index];
    out[index] = typeof value === "string" && value.trim() !== "" ? value : null;
  }
  return out;
}

/** 按格子编号顺序取出窗口。 */
export function windowIdsInSlots(slots: GridSlots): readonly string[] {
  return slots.filter((id): id is string => id !== null);
}

export function tabWindowIds(tab: WorkbenchTab): readonly string[] {
  return windowIdsInSlots(tab.slots);
}

export function slotIndexOf(slots: GridSlots, windowId: string): number {
  return slots.indexOf(windowId);
}

export function firstEmptySlot(slots: GridSlots): number {
  return slots.indexOf(null);
}

export function withSlot(slots: GridSlots, index: number, windowId: string | null): GridSlots {
  const next = normalizeSlots(slots);
  next[index] = windowId;
  return next;
}

/** 格子在这个方向下的行列。 */
export function slotPosition(
  index: number,
  orientation: GridOrientation,
): { readonly row: number; readonly col: number } {
  const { cols } = GRID_SHAPE[orientation];
  return { row: Math.floor(index / cols), col: index % cols };
}

export function slotAt(row: number, col: number, orientation: GridOrientation): number {
  return row * GRID_SHAPE[orientation].cols + col;
}

/** 同一行、在 index 右边最近的空格；没有返回 -1。 */
export function emptySlotRightOf(
  slots: GridSlots,
  index: number,
  orientation: GridOrientation,
): number {
  const { cols } = GRID_SHAPE[orientation];
  const { row, col } = slotPosition(index, orientation);
  for (let c = col + 1; c < cols; c += 1) {
    const candidate = slotAt(row, c, orientation);
    if (slots[candidate] === null) {
      return candidate;
    }
  }
  return -1;
}

/** 同一列、在 index 下面最近的空格；没有返回 -1。 */
export function emptySlotBelow(
  slots: GridSlots,
  index: number,
  orientation: GridOrientation,
): number {
  const { rows } = GRID_SHAPE[orientation];
  const { row, col } = slotPosition(index, orientation);
  for (let r = row + 1; r < rows; r += 1) {
    const candidate = slotAt(r, col, orientation);
    if (slots[candidate] === null) {
      return candidate;
    }
  }
  return -1;
}

/** 工作台区域的方向：宽高比在 0.9–1.1 之间保持当前方向，免得拖主窗口时来回跳。 */
export function orientationFor(
  width: number,
  height: number,
  current: GridOrientation,
): GridOrientation {
  if (width <= 0 || height <= 0) {
    return current;
  }
  const ratio = width / height;
  if (ratio >= 1.1) {
    return "landscape";
  }
  if (ratio <= 0.9) {
    return "portrait";
  }
  return current;
}

// ---------- 比例 ----------

export interface GridSizesForOrientation {
  /** 各行高度比例（和为 1）。 */
  readonly rows: readonly number[];
  /** 每一行里各列宽度比例（各自和为 1）。 */
  readonly cols: readonly (readonly number[])[];
}

function evenly(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

function normalizeFractions(values: readonly unknown[] | undefined, count: number): number[] {
  if (values === undefined || values.length !== count) {
    return evenly(count);
  }
  const cleaned = values.map((value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0,
  );
  const sum = cleaned.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    return evenly(count);
  }
  return cleaned.map((value) => value / sum);
}

/** 这个方向下的行高和每行列宽；没调过的均分。 */
export function gridSizesFor(
  sizes: WorkbenchGridSizes | undefined,
  orientation: GridOrientation,
): GridSizesForOrientation {
  const { rows, cols } = GRID_SHAPE[orientation];
  const stored = sizes?.[orientation];
  return {
    rows: normalizeFractions(stored?.rows, rows),
    cols: Array.from({ length: rows }, (_, row) => normalizeFractions(stored?.cols?.[row], cols)),
  };
}

export function withRowSizes(
  sizes: WorkbenchGridSizes | undefined,
  orientation: GridOrientation,
  rows: readonly number[],
): WorkbenchGridSizes {
  const current = gridSizesFor(sizes, orientation);
  return {
    ...(sizes ?? {}),
    [orientation]: {
      rows: normalizeFractions(rows, GRID_SHAPE[orientation].rows),
      cols: current.cols,
    },
  };
}

export function withColSizes(
  sizes: WorkbenchGridSizes | undefined,
  orientation: GridOrientation,
  row: number,
  cols: readonly number[],
): WorkbenchGridSizes {
  const current = gridSizesFor(sizes, orientation);
  const nextCols = current.cols.map((values, index) =>
    index === row ? normalizeFractions(cols, GRID_SHAPE[orientation].cols) : values,
  );
  return { ...(sizes ?? {}), [orientation]: { rows: current.rows, cols: nextCols } };
}

/** 双击分隔线：这个方向恢复均分。 */
export function resetGridSizes(
  sizes: WorkbenchGridSizes | undefined,
  orientation: GridOrientation,
): WorkbenchGridSizes | undefined {
  if (sizes === undefined) {
    return undefined;
  }
  const { [orientation]: _drop, ...rest } = sizes;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

// ---------- 布局操作 ----------

export function newTab(
  id: string,
  title: string,
  firstWindowId?: string,
  teamOf?: string,
): WorkbenchTab {
  const slots = emptySlots();
  if (firstWindowId !== undefined) {
    slots[0] = firstWindowId;
  }
  return { id, title, slots, ...(teamOf !== undefined ? { teamOf } : {}) };
}

export function findTabOfWindow(
  layout: ProjectWorkbenchLayout,
  windowId: string,
): WorkbenchTab | undefined {
  return layout.tabs.find((tab) => tab.slots.includes(windowId));
}

function replaceTab(layout: ProjectWorkbenchLayout, tab: WorkbenchTab): ProjectWorkbenchLayout {
  return { ...layout, tabs: layout.tabs.map((item) => (item.id === tab.id ? tab : item)) };
}

function nextTabTitle(layout: ProjectWorkbenchLayout): string {
  const used = new Set(layout.tabs.map((tab) => tab.title));
  for (let n = layout.tabs.length + 1; ; n += 1) {
    const title = `Tab ${n}`;
    if (!used.has(title)) {
      return title;
    }
  }
}

export function sanitizeLayoutTitle(title: string, fallback: string): string {
  let cleaned = "";
  for (const char of title) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    cleaned += char;
  }
  cleaned = cleaned.trim().slice(0, 40);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Tony 自己开的新窗口：指定了格子且是空的就放那格；否则当前页编号最小的空格；
 * newPage（标签栏的「＋」= 新建标签）或当前页满了就开新页并切过去。
 */
export function placeUserWindow(
  layout: ProjectWorkbenchLayout,
  window: WorkbenchWindow,
  newTabId: string,
  target?: { readonly tabId?: string; readonly slot?: number; readonly newPage?: boolean },
): ProjectWorkbenchLayout {
  const windows = { ...layout.windows, [window.id]: window };
  const tabId = target?.tabId ?? layout.activeTabId;
  const tab =
    target?.newPage === true ? undefined : layout.tabs.find((item) => item.id === tabId);
  if (tab !== undefined) {
    const wanted =
      target?.slot !== undefined && tab.slots[target.slot] === null
        ? target.slot
        : firstEmptySlot(tab.slots);
    if (wanted >= 0) {
      return {
        ...replaceTab(layout, { ...tab, slots: withSlot(tab.slots, wanted, window.id) }),
        windows,
        activeTabId: tab.id,
        focusedWindowId: window.id,
        maximizedWindowId: null,
      };
    }
  }
  const created = newTab(newTabId, nextTabTitle(layout), window.id);
  return {
    ...layout,
    windows,
    tabs: [...layout.tabs, created],
    activeTabId: created.id,
    focusedWindowId: window.id,
    maximizedWindowId: null,
  };
}

/** 窗口上的「向右 / 向下分屏」：同一行右边 / 同一列下面最近的空格，没有就开新页。 */
export function placeSplitWindow(
  layout: ProjectWorkbenchLayout,
  targetWindowId: string,
  window: WorkbenchWindow,
  direction: "right" | "down",
  orientation: GridOrientation,
  newTabId: string,
): ProjectWorkbenchLayout | undefined {
  const tab = findTabOfWindow(layout, targetWindowId);
  if (tab === undefined) {
    return undefined;
  }
  const index = slotIndexOf(tab.slots, targetWindowId);
  const slot =
    direction === "right"
      ? emptySlotRightOf(tab.slots, index, orientation)
      : emptySlotBelow(tab.slots, index, orientation);
  const windows = { ...layout.windows, [window.id]: window };
  if (slot >= 0) {
    return {
      ...replaceTab(layout, { ...tab, slots: withSlot(tab.slots, slot, window.id) }),
      windows,
      activeTabId: tab.id,
      focusedWindowId: window.id,
      maximizedWindowId: null,
    };
  }
  const created = newTab(newTabId, nextTabTitle(layout), window.id);
  return {
    ...layout,
    windows,
    tabs: [...layout.tabs, created],
    activeTabId: created.id,
    focusedWindowId: window.id,
    maximizedWindowId: null,
  };
}

/**
 * 管理者开的子窗口（T10.7a 起由平台放进布局）。依次找：管理者所在的页、这个管理者已有的团队页；
 * 第一个有空格的页里放编号最小的空格；都满了才开新的「团队：管理者名」页。
 * 不切页、不抢焦点（Tony：AI 的动作不打断用户），只有落在用户正看着的那页时才把焦点给它。
 */
export function placeOpenedWindow(
  layout: ProjectWorkbenchLayout,
  managerWindowId: string,
  child: WorkbenchWindow,
  newTabId: string,
): ProjectWorkbenchLayout {
  const windows = { ...layout.windows, [child.id]: child };
  const managerTab = findTabOfWindow(layout, managerWindowId);
  const candidates = [
    ...(managerTab !== undefined ? [managerTab] : []),
    ...layout.tabs.filter((tab) => tab.teamOf === managerWindowId && tab.id !== managerTab?.id),
  ];
  for (const tab of candidates) {
    const slot = firstEmptySlot(tab.slots);
    if (slot >= 0) {
      return {
        ...replaceTab(layout, { ...tab, slots: withSlot(tab.slots, slot, child.id) }),
        windows,
        activeTabId: layout.activeTabId ?? tab.id,
      };
    }
  }
  const manager = layout.windows[managerWindowId];
  const created = newTab(
    newTabId,
    `团队：${sanitizeLayoutTitle(manager?.title ?? child.title, "窗口")}`,
    child.id,
    managerWindowId,
  );
  return {
    ...layout,
    windows,
    tabs: [...layout.tabs, created],
    activeTabId: layout.activeTabId ?? created.id,
  };
}

/**
 * 从布局里拿掉一个窗口：那格变空，别的不挪；整页都空了就关掉这页。直接子窗口标记 parentClosed。
 * 用户点关闭与 ffpane_close_window 共用。
 */
export function detachWindowFromLayout(
  layout: ProjectWorkbenchLayout,
  windowId: string,
): ProjectWorkbenchLayout {
  const nextWindows: Record<string, WorkbenchWindow> = {};
  for (const [id, node] of Object.entries(layout.windows)) {
    if (id === windowId) {
      continue;
    }
    nextWindows[id] = node.parentWindowId === windowId ? { ...node, parentClosed: true } : node;
  }
  const tabs: WorkbenchTab[] = [];
  for (const tab of layout.tabs) {
    const index = slotIndexOf(tab.slots, windowId);
    if (index < 0) {
      tabs.push(tab);
      continue;
    }
    const slots = withSlot(tab.slots, index, null);
    if (windowIdsInSlots(slots).length > 0) {
      tabs.push({ ...tab, slots });
    }
  }
  const activeTabId = tabs.some((tab) => tab.id === layout.activeTabId)
    ? layout.activeTabId
    : (tabs[0]?.id ?? null);
  const remaining = Object.keys(nextWindows);
  return {
    ...layout,
    windows: nextWindows,
    tabs,
    activeTabId,
    focusedWindowId:
      layout.focusedWindowId === windowId ? (remaining[0] ?? null) : layout.focusedWindowId,
    maximizedWindowId: layout.maximizedWindowId === windowId ? null : layout.maximizedWindowId,
  };
}
