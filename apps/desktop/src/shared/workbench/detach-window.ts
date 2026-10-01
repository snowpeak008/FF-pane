/**
 * 从布局里拿掉一个窗口：叶子折叠，直接子窗口标记 parentClosed。
 * 用户点关闭与 ffpane_close_window 共用，避免两套树手术。
 */

import type { ProjectWorkbenchLayout, WorkbenchTab, WorkbenchWindow } from "@ff-pane/shared";
import { removeLeaf } from "./pane-tree";

export function detachWindowFromLayout(
  layout: ProjectWorkbenchLayout,
  windowId: string,
): ProjectWorkbenchLayout {
  const nextWindows: Record<string, WorkbenchWindow> = {};
  for (const [id, node] of Object.entries(layout.windows)) {
    if (id === windowId) {
      continue;
    }
    if (node.parentWindowId === windowId) {
      nextWindows[id] = { ...node, parentClosed: true };
    } else {
      nextWindows[id] = node;
    }
  }
  const tabs: WorkbenchTab[] = [];
  for (const tab of layout.tabs) {
    const nextRoot = removeLeaf(tab.root, windowId);
    if (nextRoot === null) {
      continue;
    }
    tabs.push({ ...tab, root: nextRoot });
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
