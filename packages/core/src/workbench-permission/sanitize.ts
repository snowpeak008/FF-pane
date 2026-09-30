/**
 * 工作台权限树清洗与启动封顶（T10.5'）。
 * 布局读入 / 落盘 / launch-cli 共用：断环、子≤父、求有效上限。
 */

import type { WorkbenchPermissionLevel } from "@ff-pane/shared";
import {
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  minPermissionLevel,
  permissionLevelLte,
} from "@ff-pane/shared";
import type { WorkbenchAuthNode } from "./authorize.js";
import { MAX_ANCESTOR_WALK_DEPTH, walkAncestors } from "./authorize.js";

export interface SanitizeWindowsResult {
  readonly windows: Record<string, WorkbenchAuthNode>;
  /** 因环被断开 parent 的窗口 id。 */
  readonly brokenCycleIds: readonly string[];
  /** 因超过父级被封顶的窗口 id。 */
  readonly cappedIds: readonly string[];
}

/**
 * 清洗窗口表：遇环断开 parent（标 parentClosed、权限降为 read-only）；
 * 子级高于父级则封顶为父级有效权限。
 */
export function sanitizeWorkbenchAuthTree(
  input: Readonly<Record<string, WorkbenchAuthNode>>,
): SanitizeWindowsResult {
  const windows: Record<string, WorkbenchAuthNode> = { ...input };
  const brokenCycleIds: string[] = [];
  const cappedIds: string[] = [];

  // 先在原始树上标环，再统一断开（避免边改边判导致环上后继节点漏断）
  const cycleIds = new Set<string>();
  for (const id of Object.keys(windows)) {
    const walk = walkAncestors(id, windows);
    if (walk.cycle) {
      cycleIds.add(id);
      for (const ancestorId of walk.ids) {
        cycleIds.add(ancestorId);
      }
    } else if (walk.truncated) {
      cycleIds.add(id);
    }
  }
  for (const id of cycleIds) {
    const node = windows[id];
    if (node === undefined) {
      continue;
    }
    const { parentWindowId: _p, ...rest } = node;
    void _p;
    windows[id] = {
      ...rest,
      parentClosed: true,
      permission: "read-only",
      permissionNeedsDowngrade: true,
    };
    brokenCycleIds.push(id);
  }

  // 按拓扑近似：多轮封顶直到稳定（深度有限）
  for (let pass = 0; pass < MAX_ANCESTOR_WALK_DEPTH; pass += 1) {
    let changed = false;
    for (const [id, node] of Object.entries(windows)) {
      if (node.parentWindowId === undefined || node.parentWindowId.trim() === "") {
        continue;
      }
      const parent = windows[node.parentWindowId];
      if (parent === undefined) {
        continue;
      }
      if (permissionLevelLte(node.permission, parent.permission)) {
        continue;
      }
      windows[id] = {
        ...node,
        permission: parent.permission,
        permissionNeedsDowngrade: true,
      };
      if (!cappedIds.includes(id)) {
        cappedIds.push(id);
      }
      changed = true;
    }
    if (!changed) {
      break;
    }
  }

  return { windows, brokenCycleIds, cappedIds };
}

/** 沿祖先链求有效权限上限（含自身登记等级）。 */
export function resolveEffectivePermissionCeiling(
  windowId: string,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
): {
  readonly ceiling: WorkbenchPermissionLevel;
  readonly cycle: boolean;
  readonly truncated: boolean;
} {
  const self = tree[windowId];
  if (self === undefined) {
    return {
      ceiling: DEFAULT_WORKBENCH_WINDOW_PERMISSION,
      cycle: false,
      truncated: false,
    };
  }
  const walk = walkAncestors(windowId, tree);
  if (walk.cycle || walk.truncated) {
    return { ceiling: "read-only", cycle: walk.cycle, truncated: walk.truncated };
  }
  let ceiling = self.permission;
  for (const ancestorId of walk.ids) {
    const ancestor = tree[ancestorId];
    if (ancestor === undefined) {
      break;
    }
    ceiling = minPermissionLevel(ceiling, ancestor.permission);
  }
  return { ceiling, cycle: false, truncated: false };
}

/**
 * 启动时生效权限：顶层（无父）= 请求或登记；有父 = min(请求, 祖先链上限)。
 */
export function resolveLaunchPermission(input: {
  readonly windowId: string;
  readonly requested?: WorkbenchPermissionLevel;
  readonly tree: Readonly<Record<string, WorkbenchAuthNode>>;
}): {
  readonly effective: WorkbenchPermissionLevel;
  readonly capped: boolean;
  readonly cycle: boolean;
} {
  const self = input.tree[input.windowId];
  const requested = input.requested ?? self?.permission ?? DEFAULT_WORKBENCH_WINDOW_PERMISSION;
  const hasParent = self?.parentWindowId !== undefined && self.parentWindowId.trim() !== "";
  if (!hasParent) {
    return { effective: requested, capped: false, cycle: false };
  }
  const { ceiling, cycle, truncated } = resolveEffectivePermissionCeiling(
    input.windowId,
    input.tree,
  );
  if (cycle || truncated) {
    return { effective: "read-only", capped: true, cycle: cycle || truncated };
  }
  const effective = minPermissionLevel(requested, ceiling);
  return {
    effective,
    capped: effective !== requested,
    cycle: false,
  };
}
