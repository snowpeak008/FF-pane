/**
 * 工作台格子（T11.2b 起每页最多 6 个；T11.2d 起按个数自动排，Tony 2026-11-07 定）。
 * 纯函数，只依赖 @ff-pane/shared 的类型。
 *
 * - 每页最多 6 个窗口。slots 始终挤紧：前面是窗口，后面是空，中间不留空。
 * - 按个数排：横向 1 个整屏、2 个左右、3 个三列、4 个 2×2、5 个上 3 下 2、6 个上 3 下 3。
 *   竖向（高 > 宽）转 90°：2 个上下、3 个上中下、4 个 2×2、5 个左 3 右 2、6 个 2 列各 3 个。
 * - 关掉一个，剩下的往前挤、重新排。
 * - 新窗口加到末尾；「加一个窗口」加在那个窗口后面；满了开新页。
 * - 管理者开子窗口：先放管理者那页，再放这个管理者已有的团队页，都满了才开新的团队页。
 * - 拖分隔线只改相邻的两条或两格；这一页的窗口个数一变，拖过的比例就恢复均分。
 */

import type {
  ProjectWorkbenchLayout,
  WorkbenchGridSizes,
  WorkbenchTab,
  WorkbenchWindow,
} from "@ff-pane/shared";

export const GRID_SLOTS = 6;

export type GridOrientation = "landscape" | "portrait";

/**
 * 每条线放几个窗口，按窗口个数查。横向时「线」是行（从上到下），竖向时是列（从左到右）。
 */
const GRID_LINES: readonly (readonly number[])[] = [[], [1], [2], [3], [2, 2], [3, 2], [3, 3]];

export function gridLines(count: number): readonly number[] {
  return GRID_LINES[Math.max(0, Math.min(GRID_SLOTS, count))] ?? [];
}

export type GridSlots = readonly (string | null)[];

export function emptySlots(): (string | null)[] {
  return Array.from({ length: GRID_SLOTS }, () => null);
}

/** 挤紧并补齐到 6 格：窗口按原来的顺序排在前面；不认识的值、重复的窗口去掉。 */
export function normalizeSlots(slots: readonly unknown[]): (string | null)[] {
  const ids: string[] = [];
  for (const value of slots) {
    if (typeof value === "string" && value.trim() !== "" && !ids.includes(value)) {
      ids.push(value);
    }
  }
  return Array.from({ length: GRID_SLOTS }, (_, index) => ids[index] ?? null);
}

/** 按顺序取出窗口。 */
export function windowIdsInSlots(slots: GridSlots): readonly string[] {
  return slots.filter((id): id is string => id !== null);
}

export function tabWindowIds(tab: WorkbenchTab): readonly string[] {
  return windowIdsInSlots(tab.slots);
}

export function slotIndexOf(slots: GridSlots, windowId: string): number {
  return slots.indexOf(windowId);
}

/** 加一个窗口：放在 index 位置（缺省末尾），后面的往后挪；满了返回 undefined。 */
export function insertIntoSlots(
  slots: GridSlots,
  windowId: string,
  index?: number,
): (string | null)[] | undefined {
  const ids = [...windowIdsInSlots(slots)];
  if (ids.length >= GRID_SLOTS) {
    return undefined;
  }
  const at = index === undefined ? ids.length : Math.max(0, Math.min(ids.length, index));
  ids.splice(at, 0, windowId);
  return normalizeSlots(ids);
}

/** 拿掉一个窗口，后面的往前挤。 */
export function removeFromSlots(slots: GridSlots, windowId: string): (string | null)[] {
  return normalizeSlots(windowIdsInSlots(slots).filter((id) => id !== windowId));
}

/** 对调两个位置上的窗口。 */
export function swapSlots(slots: GridSlots, a: number, b: number): (string | null)[] {
  const next = [...slots];
  const first = next[a] ?? null;
  next[a] = next[b] ?? null;
  next[b] = first;
  return normalizeSlots(next);
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

/**
 * 某个方向下拖过的比例。存档里的字段名沿用 rows / cols：rows 是各条线的比例，
 * cols 是每条线里各格的比例。横向时线是行，竖向时线是列。
 */
export interface GridSizesForOrientation {
  /** 各条线的比例（和为 1）。 */
  readonly lines: readonly number[];
  /** 每条线里各格的比例（各自和为 1）。 */
  readonly cells: readonly (readonly number[])[];
}

/** 每格最小占比。1366 宽横向三列约 135px 起，够看标题。 */
export const GRID_MIN_FRACTION = 0.1;

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

/** 这个方向、这么多个窗口时的比例；没调过或和个数对不上的均分。 */
export function gridSizesFor(
  sizes: WorkbenchGridSizes | undefined,
  orientation: GridOrientation,
  count: number,
): GridSizesForOrientation {
  const lines = gridLines(count);
  const stored = sizes?.[orientation];
  return {
    lines: normalizeFractions(stored?.rows, lines.length),
    cells: lines.map((cells, line) => normalizeFractions(stored?.cols?.[line], cells)),
  };
}

function storeSizes(
  sizes: WorkbenchGridSizes | undefined,
  orientation: GridOrientation,
  value: GridSizesForOrientation,
): WorkbenchGridSizes {
  return { ...(sizes ?? {}), [orientation]: { rows: value.lines, cols: value.cells } };
}

export function withLineSizes(
  sizes: WorkbenchGridSizes | undefined,
  orientation: GridOrientation,
  count: number,
  lines: readonly number[],
): WorkbenchGridSizes {
  const current = gridSizesFor(sizes, orientation, count);
  return storeSizes(sizes, orientation, {
    lines: normalizeFractions(lines, current.lines.length),
    cells: current.cells,
  });
}

export function withCellSizes(
  sizes: WorkbenchGridSizes | undefined,
  orientation: GridOrientation,
  count: number,
  line: number,
  cells: readonly number[],
): WorkbenchGridSizes {
  const current = gridSizesFor(sizes, orientation, count);
  return storeSizes(sizes, orientation, {
    lines: current.lines,
    cells: current.cells.map((values, index) =>
      index === line ? normalizeFractions(cells, values.length) : values,
    ),
  });
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

/**
 * 拖第 index 条分隔线（在 index - 1 和 index 之间）挪了 delta：只改这两份，
 * 两份都不小于 GRID_MIN_FRACTION。
 */
export function resizePair(
  fractions: readonly number[],
  index: number,
  delta: number,
): readonly number[] {
  const before = fractions[index - 1];
  const after = fractions[index];
  if (before === undefined || after === undefined || !Number.isFinite(delta)) {
    return fractions;
  }
  const pair = before + after;
  if (pair < GRID_MIN_FRACTION * 2) {
    return fractions;
  }
  const nextBefore = Math.max(
    GRID_MIN_FRACTION,
    Math.min(pair - GRID_MIN_FRACTION, before + delta),
  );
  return fractions.map((value, i) =>
    i === index - 1 ? nextBefore : i === index ? pair - nextBefore : value,
  );
}

// ---------- 位置 ----------

/** 占工作台区域的比例，0–1。 */
export interface GridRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function prefix(values: readonly number[], index: number): number {
  let sum = 0;
  for (let i = 0; i < index; i += 1) {
    sum += values[i] ?? 0;
  }
  return sum;
}

/** 第 slot 个窗口在第几条线、线里第几个。 */
export function slotLine(
  count: number,
  slot: number,
): { readonly line: number; readonly cell: number } {
  const lines = gridLines(count);
  let rest = slot;
  for (let line = 0; line < lines.length; line += 1) {
    const cells = lines[line] ?? 0;
    if (rest < cells) {
      return { line, cell: rest };
    }
    rest -= cells;
  }
  return { line: -1, cell: -1 };
}

/** 每个窗口占的位置，按 slots 的顺序。 */
export function gridCellRects(
  count: number,
  orientation: GridOrientation,
  sizes: GridSizesForOrientation,
): readonly GridRect[] {
  const lines = gridLines(count);
  const rects: GridRect[] = [];
  lines.forEach((cells, line) => {
    const lineStart = prefix(sizes.lines, line);
    const lineSize = sizes.lines[line] ?? 0;
    const cellSizes = sizes.cells[line] ?? [];
    for (let cell = 0; cell < cells; cell += 1) {
      const cellStart = prefix(cellSizes, cell);
      const cellSize = cellSizes[cell] ?? 0;
      rects.push(
        orientation === "landscape"
          ? { left: cellStart, top: lineStart, width: cellSize, height: lineSize }
          : { left: lineStart, top: cellStart, width: lineSize, height: cellSize },
      );
    }
  });
  return rects;
}

/**
 * 分隔线。kind "line" 在第 index - 1 条和第 index 条线之间，横跨整个区域；
 * kind "cell" 在第 line 条线里第 index - 1 格和第 index 格之间，只跨这条线。
 * at 是分隔线在它挪动方向上的位置，from / to 是它沿着自己方向的起止，都是 0–1。
 * vertical 为 true 是竖线（左右拖），否则是横线（上下拖）。
 */
export interface GridDivider {
  readonly kind: "line" | "cell";
  readonly line: number;
  readonly index: number;
  readonly at: number;
  readonly from: number;
  readonly to: number;
  readonly vertical: boolean;
}

export function gridDividers(
  count: number,
  orientation: GridOrientation,
  sizes: GridSizesForOrientation,
): readonly GridDivider[] {
  const lines = gridLines(count);
  const landscape = orientation === "landscape";
  const out: GridDivider[] = [];
  for (let line = 1; line < lines.length; line += 1) {
    out.push({
      kind: "line",
      line,
      index: line,
      at: prefix(sizes.lines, line),
      from: 0,
      to: 1,
      vertical: !landscape,
    });
  }
  lines.forEach((cells, line) => {
    const from = prefix(sizes.lines, line);
    const to = from + (sizes.lines[line] ?? 0);
    const cellSizes = sizes.cells[line] ?? [];
    for (let index = 1; index < cells; index += 1) {
      out.push({
        kind: "cell",
        line,
        index,
        at: prefix(cellSizes, index),
        from,
        to,
        vertical: landscape,
      });
    }
  });
  return out;
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

/** 换一页的窗口；个数变了就丢掉拖过的比例（排法变了，旧比例对不上）。 */
function withTabSlots(tab: WorkbenchTab, slots: GridSlots): WorkbenchTab {
  if (windowIdsInSlots(slots).length === windowIdsInSlots(tab.slots).length) {
    return { ...tab, slots };
  }
  const { sizes: _drop, ...rest } = tab;
  return { ...rest, slots };
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
 * Tony 自己开的新窗口：afterWindowId（窗口上的「加一个窗口」）放在那个窗口后面，
 * 否则加到当前页末尾；newPage（标签栏的「＋」= 新建标签）或那页满了就开新页并切过去。
 */
export function placeUserWindow(
  layout: ProjectWorkbenchLayout,
  window: WorkbenchWindow,
  newTabId: string,
  target?: { readonly tabId?: string; readonly afterWindowId?: string; readonly newPage?: boolean },
): ProjectWorkbenchLayout {
  const windows = { ...layout.windows, [window.id]: window };
  const after =
    target?.afterWindowId !== undefined ? findTabOfWindow(layout, target.afterWindowId) : undefined;
  const tabId = after?.id ?? target?.tabId ?? layout.activeTabId;
  const tab = target?.newPage === true ? undefined : layout.tabs.find((item) => item.id === tabId);
  if (tab !== undefined) {
    const index =
      after !== undefined && target?.afterWindowId !== undefined
        ? slotIndexOf(tab.slots, target.afterWindowId) + 1
        : undefined;
    const slots = insertIntoSlots(tab.slots, window.id, index);
    if (slots !== undefined) {
      return {
        ...replaceTab(layout, withTabSlots(tab, slots)),
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

/**
 * 管理者开的子窗口（T10.7a 起由平台放进布局）。依次找：管理者所在的页、这个管理者已有的团队页；
 * 放进第一个没满的页的末尾；都满了才开新的「团队：管理者名」页。
 * 不切页、不抢焦点（Tony：AI 的动作不打断用户）。
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
    const slots = insertIntoSlots(tab.slots, child.id);
    if (slots !== undefined) {
      return {
        ...replaceTab(layout, withTabSlots(tab, slots)),
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
 * 从布局里拿掉一个窗口：同页后面的往前挤、重新排；整页都空了就关掉这页。直接子窗口标记 parentClosed。
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
    if (slotIndexOf(tab.slots, windowId) < 0) {
      tabs.push(tab);
      continue;
    }
    const slots = removeFromSlots(tab.slots, windowId);
    if (windowIdsInSlots(slots).length > 0) {
      tabs.push(withTabSlots(tab, slots));
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

// ---------- 拖窗口换位置（T11.2c） ----------

/** 窗口拖到哪：另一个窗口上、某个标签、标签栏的「＋」。 */
export type WindowDropTarget =
  | { readonly kind: "slot"; readonly tabId: string; readonly slot: number }
  | { readonly kind: "tab"; readonly tabId: string }
  | { readonly kind: "new-tab" };

/** 从落点元素的 data-drop / data-tab-id / data-slot 读出落点。 */
export function dropTargetOf(
  data: Readonly<Record<string, string | undefined>>,
): WindowDropTarget | null {
  const tabId = data["tabId"];
  switch (data["drop"]) {
    case "slot": {
      const slot = Number(data["slot"]);
      return tabId !== undefined && data["slot"] !== undefined && Number.isInteger(slot)
        ? { kind: "slot", tabId, slot }
        : null;
    }
    case "tab":
      return tabId !== undefined ? { kind: "tab", tabId } : null;
    case "new-tab":
      return { kind: "new-tab" };
    default:
      return null;
  }
}

export type MoveWindowResult =
  | { readonly ok: true; readonly layout: ProjectWorkbenchLayout }
  | { readonly ok: false; readonly reason: "full" | "unchanged" };

/**
 * 拖窗口：落到同页另一个窗口上两个对调；落到别的页加到那页末尾，满了不让放；
 * 落到「＋」开新页。只改格子，窗口本身不动。原来那页空了就去掉；停在当前页，除非当前页被去掉了。
 */
export function moveWindowInLayout(
  layout: ProjectWorkbenchLayout,
  windowId: string,
  target: WindowDropTarget,
  newTabId: string,
): MoveWindowResult {
  const from = findTabOfWindow(layout, windowId);
  if (from === undefined) {
    return { ok: false, reason: "unchanged" };
  }
  const fromSlot = slotIndexOf(from.slots, windowId);
  if (target.kind === "slot" && target.tabId === from.id) {
    if (target.slot === fromSlot || (from.slots[target.slot] ?? null) === null) {
      return { ok: false, reason: "unchanged" };
    }
    return {
      ok: true,
      layout: replaceTab(layout, withTabSlots(from, swapSlots(from.slots, fromSlot, target.slot))),
    };
  }
  const alone = windowIdsInSlots(from.slots).length === 1;
  if (target.kind === "new-tab" ? alone : target.tabId === from.id) {
    return { ok: false, reason: "unchanged" };
  }
  let tabs: WorkbenchTab[];
  if (target.kind === "new-tab") {
    tabs = [...layout.tabs, newTab(newTabId, nextTabTitle(layout), windowId)];
  } else {
    const to = layout.tabs.find((tab) => tab.id === target.tabId);
    if (to === undefined) {
      return { ok: false, reason: "unchanged" };
    }
    const slots = insertIntoSlots(to.slots, windowId);
    if (slots === undefined) {
      return { ok: false, reason: "full" };
    }
    tabs = layout.tabs.map((tab) => (tab.id === to.id ? withTabSlots(tab, slots) : tab));
  }
  const emptied = removeFromSlots(from.slots, windowId);
  tabs = tabs.flatMap((tab) => {
    if (tab.id !== from.id) {
      return [tab];
    }
    return windowIdsInSlots(emptied).length > 0 ? [withTabSlots(tab, emptied)] : [];
  });
  const activeTabId = tabs.some((tab) => tab.id === layout.activeTabId)
    ? layout.activeTabId
    : (findTabOfWindow({ ...layout, tabs }, windowId)?.id ?? null);
  return {
    ok: true,
    layout: {
      ...layout,
      tabs,
      activeTabId,
      maximizedWindowId: layout.maximizedWindowId === windowId ? null : layout.maximizedWindowId,
    },
  };
}
