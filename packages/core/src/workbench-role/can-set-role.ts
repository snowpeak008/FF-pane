/**
 * 工作台角色设定裁决（T10.6）。
 * 纯函数。T10.7 的 ffpane_set_role 与界面「设为…」都走这里。
 */

import type { WorkbenchOpenedBy, WorkbenchRole } from "@ff-pane/shared";
import { isWorkbenchRole } from "@ff-pane/shared";
import type { WorkbenchAuthActor, WorkbenchAuthNode } from "../workbench-permission/authorize.js";
import { isDescendantOf } from "../workbench-permission/authorize.js";

/** 被设定角色的窗口（结构字段；权限树里已有节点时以树为准）。 */
export interface CanSetRoleTarget {
  readonly id: string;
  readonly openedBy?: WorkbenchOpenedBy;
  readonly parentWindowId?: string;
}

function isTopLevel(parentWindowId: string | undefined): boolean {
  return parentWindowId === undefined || parentWindowId.trim() === "";
}

function effectiveTarget(
  target: CanSetRoleTarget,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
): {
  readonly openedBy: WorkbenchOpenedBy | undefined;
  readonly parentWindowId: string | undefined;
} {
  const node = tree[target.id];
  if (node !== undefined) {
    return { openedBy: node.openedBy, parentWindowId: node.parentWindowId };
  }
  return { openedBy: target.openedBy, parentWindowId: target.parentWindowId };
}

/**
 * 谁可以把 target 设成 newRole。
 * - 用户（界面）可设任意窗口的任意角色。
 * - 窗口把自己设为 manager：仅 openedBy=user、没有父窗口、且没有被冷启动清洗锁住的顶层窗口。
 * - 窗口可设定自己后代的角色（任意角色）。
 * - 其它一律拒绝。环上的“后代”关系不成立。
 */
export function canSetRole(
  actor: WorkbenchAuthActor,
  targetWindow: CanSetRoleTarget,
  newRole: WorkbenchRole,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
): boolean {
  if (!isWorkbenchRole(newRole) || targetWindow.id.trim() === "") {
    return false;
  }
  if (actor.kind === "user") {
    return true;
  }
  if (actor.kind !== "window" || actor.windowId.trim() === "") {
    return false;
  }
  if (actor.windowId === targetWindow.id) {
    const info = effectiveTarget(targetWindow, tree);
    if (tree[targetWindow.id]?.sanitizeLocked === true) {
      return false;
    }
    return newRole === "manager" && info.openedBy === "user" && isTopLevel(info.parentWindowId);
  }
  return isDescendantOf(actor.windowId, targetWindow.id, tree);
}
