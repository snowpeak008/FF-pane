/**
 * T11.22：现任管理者与待命管理者。纯函数。
 * 待命管理者的 standbyOf 是接任它的现任管理者的窗口编号。
 * 现任对待命管理者和它的整个后代视同上级：可发消息、读输出、关闭、改权限。
 * 父子关系（parentWindowId）本身不动，权限封顶链也不动。
 */

import type { WorkbenchAuthNode } from "./authorize.js";
import { isDescendantOf } from "./authorize.js";

type AuthTree = Readonly<Record<string, WorkbenchAuthNode>>;

/** 待命在 managerId 名下的管理者窗口编号。 */
export function standbyManagerIds(managerId: string, tree: AuthTree): readonly string[] {
  return Object.keys(tree).filter((id) => tree[id]?.standbyOf === managerId);
}

/** 窗口是否处于待命（已被别的管理者接任）。 */
export function isStandbyManager(windowId: string, tree: AuthTree): boolean {
  const standbyOf = tree[windowId]?.standbyOf;
  return standbyOf !== undefined && standbyOf.trim() !== "";
}

/**
 * managerId 是否视同 targetId 的上级：
 * 真祖先，或者 managerId 是现任管理者，而 target 是它名下待命管理者本人或其后代。
 * 自己不管自己；待命的管理者不能借此管别人。
 */
export function controlsWindow(managerId: string, targetId: string, tree: AuthTree): boolean {
  if (managerId === targetId) {
    return false;
  }
  if (isDescendantOf(managerId, targetId, tree)) {
    return true;
  }
  const caller = tree[managerId];
  if (caller === undefined || caller.role !== "manager" || isStandbyManager(managerId, tree)) {
    return false;
  }
  for (const standbyId of standbyManagerIds(managerId, tree)) {
    if (standbyId === targetId || isDescendantOf(standbyId, targetId, tree)) {
      return true;
    }
  }
  return false;
}

/**
 * 汇报改道：目标是待命管理者时改送现任；否则原样返回。
 * 只走一跳，注册表在换现任时负责把旧的 standbyOf 改指新现任。
 */
export function reportRedirectTarget(targetId: string, tree: AuthTree): string {
  const standbyOf = tree[targetId]?.standbyOf;
  if (standbyOf !== undefined && standbyOf.trim() !== "" && tree[standbyOf] !== undefined) {
    return standbyOf;
  }
  return targetId;
}
