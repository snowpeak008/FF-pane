/**
 * 把管理者开出的子窗口放进布局（T10.7a）。
 * 默认与管理者同一标签页左右分屏；该标签页已有 4 个窗口时改开新标签页。
 */

import type { ProjectWorkbenchLayout, WorkbenchTab, WorkbenchWindow } from "@ff-pane/shared";
import { collectWindowIds, leafPane, splitLeaf } from "./pane-tree";

/** 同一标签页超过这个数量（含）就新开团队标签页。 */
export const WORKBENCH_TAB_WINDOW_SOFT_LIMIT = 4;

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

export function placeOpenedWindow(
  layout: ProjectWorkbenchLayout,
  managerWindowId: string,
  child: WorkbenchWindow,
  newTabId: string,
): ProjectWorkbenchLayout {
  const managerTab = layout.tabs.find((tab) =>
    collectWindowIds(tab.root).includes(managerWindowId),
  );
  const windows = { ...layout.windows, [child.id]: child };
  if (managerTab === undefined) {
    const tab: WorkbenchTab = {
      id: newTabId,
      title: `团队：${sanitizeLayoutTitle(child.title, "窗口")}`,
      root: leafPane(child.id),
    };
    return {
      ...layout,
      windows,
      tabs: [...layout.tabs, tab],
      activeTabId: tab.id,
      focusedWindowId: child.id,
      maximizedWindowId: null,
    };
  }
  const count = collectWindowIds(managerTab.root).length;
  if (count >= WORKBENCH_TAB_WINDOW_SOFT_LIMIT) {
    const manager = layout.windows[managerWindowId];
    const tab: WorkbenchTab = {
      id: newTabId,
      title: `团队：${sanitizeLayoutTitle(manager?.title ?? "", "窗口")}`,
      root: leafPane(child.id),
    };
    return {
      ...layout,
      windows,
      tabs: [...layout.tabs, tab],
      activeTabId: tab.id,
      focusedWindowId: child.id,
      maximizedWindowId: null,
    };
  }
  const root = splitLeaf(managerTab.root, managerWindowId, child.id, "horizontal");
  return {
    ...layout,
    windows,
    focusedWindowId: child.id,
    maximizedWindowId: null,
    tabs: layout.tabs.map((tab) => (tab.id === managerTab.id ? { ...tab, root } : tab)),
    activeTabId: managerTab.id,
  };
}
