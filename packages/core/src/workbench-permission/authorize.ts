/**
 * 工作台窗口层级与授权裁决（T10.5）。
 * 纯函数；T10.7 MCP 工具必须以本模块为唯一裁决依据。
 */

import type { WorkbenchOpenedBy, WorkbenchPermissionLevel, WorkbenchRole } from "@ff-pane/shared";
import { minPermissionLevel, permissionLevelLte } from "@ff-pane/shared";

/** 授权树中的窗口节点。 */
export interface WorkbenchAuthNode {
  readonly id: string;
  readonly permission: WorkbenchPermissionLevel;
  readonly parentWindowId?: string;
  readonly parentClosed?: boolean;
  readonly openedBy: WorkbenchOpenedBy;
  readonly permissionNeedsDowngrade?: boolean;
  /**
   * 冷启动把父级缺失或成环降成只读后置位。
   * 同一会话内的同步不得抬高权限或改回用户开启；续接不得因此重新授权。
   * 只有界面用户显式改权限时才清掉。
   */
  readonly sanitizeLocked?: boolean;
  /** 界面用户显式改过权限后，不再因父级缺失把这次选择降回只读。 */
  readonly userElevated?: boolean;
  /** 界面用户显式改过角色后，续接才允许重新授予管理权。 */
  readonly userRoleSet?: boolean;
  /** T10.6：窗口角色。缺省视为 none。 */
  readonly role?: WorkbenchRole;
}

/** 调用方：界面用户（最高）或某窗口。 */
export type WorkbenchAuthActor =
  | { readonly kind: "user" }
  | { readonly kind: "window"; readonly windowId: string };

/**
 * 控制类：仅允许对自己的后代。
 * 汇报类：仅允许对祖先（含已关闭父级链路）。
 * 消息类：默认拒绝（最小权限；T10.7 若要同父兄弟可再放宽）。
 */
export type WorkbenchAuthAction =
  | "open-child"
  | "send-command"
  | "read-output"
  | "close"
  | "adjust-permission"
  | "report"
  | "send-message";

const CONTROL_ACTIONS = new Set<WorkbenchAuthAction>(["send-command", "read-output", "close"]);

export interface AuthorizeInput {
  readonly actor: WorkbenchAuthActor;
  readonly action: WorkbenchAuthAction;
  readonly targetWindowId: string;
  readonly tree: Readonly<Record<string, WorkbenchAuthNode>>;
  /** adjust-permission 时拟设等级。 */
  readonly newPermission?: WorkbenchPermissionLevel;
}

export type AuthorizeDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** 子等级不得超过父等级。 */
export function canDelegate(
  parentLevel: WorkbenchPermissionLevel,
  childLevel: WorkbenchPermissionLevel,
): boolean {
  return permissionLevelLte(childLevel, parentLevel);
}

/** 祖先遍历深度上限（防畸形超深链）。 */
export const MAX_ANCESTOR_WALK_DEPTH = 64;

export interface AncestorWalkResult {
  readonly ids: readonly string[];
  /** 检测到环（含自环）。 */
  readonly cycle: boolean;
  /** 超过 {@link MAX_ANCESTOR_WALK_DEPTH}。 */
  readonly truncated: boolean;
}

/**
 * 沿 parentWindowId 收集祖先 id（近→远）。
 * 遇环或超深立即停止并标记；环上节点**不得**当作合法祖先关系。
 */
export function walkAncestors(
  windowId: string,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
  maxDepth: number = MAX_ANCESTOR_WALK_DEPTH,
): AncestorWalkResult {
  const out: string[] = [];
  const seen = new Set<string>([windowId]);
  let current = tree[windowId];
  let depth = 0;
  while (current?.parentWindowId !== undefined && current.parentWindowId.trim() !== "") {
    depth += 1;
    if (depth > maxDepth) {
      return { ids: out, cycle: false, truncated: true };
    }
    const parentId = current.parentWindowId;
    if (parentId === windowId || seen.has(parentId)) {
      return { ids: out, cycle: true, truncated: false };
    }
    seen.add(parentId);
    out.push(parentId);
    current = tree[parentId];
    if (current === undefined) {
      break;
    }
  }
  return { ids: out, cycle: false, truncated: false };
}

/** @deprecated 请用 {@link walkAncestors}；环时返回已收集前缀且不含环回边。 */
export function listAncestorIds(
  windowId: string,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
): readonly string[] {
  return walkAncestors(windowId, tree).ids;
}

/** target 是否为 ancestorId 的真后代；环 / 超深 → false。 */
export function isDescendantOf(
  ancestorId: string,
  targetId: string,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
): boolean {
  if (ancestorId === targetId) {
    return false;
  }
  const walk = walkAncestors(targetId, tree);
  if (walk.cycle || walk.truncated) {
    return false;
  }
  return walk.ids.includes(ancestorId);
}

/** 是否祖先（含已关闭父：只要 parentWindowId 链能走到）。 */
export function isAncestorOf(
  maybeAncestorId: string,
  targetId: string,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
): boolean {
  return isDescendantOf(maybeAncestorId, targetId, tree);
}

function sameParentSiblings(
  a: string,
  b: string,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
): boolean {
  const wa = tree[a];
  const wb = tree[b];
  if (wa === undefined || wb === undefined) {
    return false;
  }
  const pa = wa.parentWindowId;
  const pb = wb.parentWindowId;
  return pa !== undefined && pb !== undefined && pa === pb && pa.trim() !== "" && a !== b;
}

/**
 * 裁决控制 / 汇报 / 消息动作。
 * 用户（界面）恒允许；窗口不得提升自己或祖先；调整后代不得超过自己。
 */
export function authorize(input: AuthorizeInput): AuthorizeDecision {
  const { actor, action, targetWindowId, tree } = input;
  const target = tree[targetWindowId];

  if (actor.kind === "user") {
    if (action === "adjust-permission" && input.newPermission === undefined) {
      return { ok: false, reason: "missing-new-permission" };
    }
    if (target === undefined && action !== "report") {
      return { ok: false, reason: "target-not-found" };
    }
    return { ok: true };
  }

  const callerId = actor.windowId;
  const caller = tree[callerId];
  if (caller === undefined) {
    return { ok: false, reason: "caller-not-found" };
  }

  if (action === "report") {
    if (targetWindowId === callerId) {
      return { ok: false, reason: "cannot-report-self" };
    }
    if (target !== undefined && isAncestorOf(targetWindowId, callerId, tree)) {
      return { ok: true };
    }
    if (caller.parentWindowId === targetWindowId) {
      return { ok: true };
    }
    if (target === undefined) {
      return { ok: false, reason: "target-not-found" };
    }
    return { ok: false, reason: "report-only-to-ancestor" };
  }

  if (target === undefined) {
    return { ok: false, reason: "target-not-found" };
  }

  const callerWalk = walkAncestors(callerId, tree);
  const targetWalk = walkAncestors(targetWindowId, tree);
  if (callerWalk.cycle || targetWalk.cycle) {
    return { ok: false, reason: "cycle-detected" };
  }
  if (callerWalk.truncated || targetWalk.truncated) {
    return { ok: false, reason: "ancestry-too-deep" };
  }

  if (action === "adjust-permission") {
    const next = input.newPermission;
    if (next === undefined) {
      return { ok: false, reason: "missing-new-permission" };
    }
    if (targetWindowId === callerId) {
      return { ok: false, reason: "cannot-adjust-self" };
    }
    if (targetWalk.ids.includes(callerId) === false && callerWalk.ids.includes(targetWindowId)) {
      return { ok: false, reason: "cannot-adjust-ancestor" };
    }
    if (!targetWalk.ids.includes(callerId)) {
      return { ok: false, reason: "not-descendant" };
    }
    if (!canDelegate(caller.permission, next)) {
      return { ok: false, reason: "exceeds-caller-ceiling" };
    }
    return { ok: true };
  }

  if (action === "send-message") {
    if (targetWindowId === callerId) {
      return { ok: false, reason: "cannot-message-self" };
    }
    if (callerWalk.ids.includes(targetWindowId)) {
      return { ok: false, reason: "use-report-for-ancestor" };
    }
    if (targetWalk.ids.includes(callerId)) {
      return { ok: true };
    }
    if (sameParentSiblings(callerId, targetWindowId, tree)) {
      return { ok: false, reason: "sibling-message-denied" };
    }
    return { ok: false, reason: "unrelated-denied" };
  }

  if (CONTROL_ACTIONS.has(action)) {
    if (targetWindowId === callerId) {
      return { ok: false, reason: "control-self-denied" };
    }
    if (!targetWalk.ids.includes(callerId)) {
      return { ok: false, reason: "not-descendant" };
    }
    return { ok: true };
  }

  if (action === "open-child") {
    return authorizeOpenChild({
      actor,
      parentWindowId: targetWindowId,
      childPermission: input.newPermission ?? caller.permission,
      tree,
    });
  }

  return { ok: false, reason: "unknown-action" };
}

/**
 * 在 caller 下开子窗口：target 为 caller；子等级须 ≤ caller。
 */
export function authorizeOpenChild(input: {
  readonly actor: WorkbenchAuthActor;
  readonly parentWindowId: string;
  readonly childPermission: WorkbenchPermissionLevel;
  readonly tree: Readonly<Record<string, WorkbenchAuthNode>>;
}): AuthorizeDecision {
  if (input.actor.kind === "user") {
    return { ok: true };
  }
  if (input.actor.windowId !== input.parentWindowId) {
    return { ok: false, reason: "open-child-only-under-self" };
  }
  const parent = input.tree[input.parentWindowId];
  if (parent === undefined) {
    return { ok: false, reason: "parent-not-found" };
  }
  if (!canDelegate(parent.permission, input.childPermission)) {
    return { ok: false, reason: "exceeds-parent-ceiling" };
  }
  return { ok: true };
}

/** 有效启动等级：若需降级则相对 ceiling 封顶。 */
export function effectiveLaunchPermission(
  configured: WorkbenchPermissionLevel,
  ceiling: WorkbenchPermissionLevel | undefined,
  needsDowngrade: boolean | undefined,
): WorkbenchPermissionLevel {
  if (ceiling === undefined || needsDowngrade !== true) {
    return ceiling !== undefined ? minPermissionLevel(configured, ceiling) : configured;
  }
  return minPermissionLevel(configured, ceiling);
}

/**
 * 用户/父级把某窗口降到 newLevel 后：自身写入新等级；
 * 后代中超过上限的标记 permissionNeedsDowngrade，并在返回副本里把 permission 封顶为展示值。
 * 正在运行的进程不热改——调用方提示重启。
 */
export function applyPermissionDowngrade(
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
  windowId: string,
  newLevel: WorkbenchPermissionLevel,
): Record<string, WorkbenchAuthNode> {
  const next: Record<string, WorkbenchAuthNode> = { ...tree };
  const self = next[windowId];
  if (self === undefined) {
    return next;
  }
  next[windowId] = {
    ...self,
    permission: newLevel,
    permissionNeedsDowngrade: false,
  };
  for (const [id, node] of Object.entries(tree)) {
    if (id === windowId || !isDescendantOf(windowId, id, tree)) {
      continue;
    }
    if (permissionLevelLte(node.permission, newLevel)) {
      next[id] = {
        ...node,
        permissionNeedsDowngrade: false,
      };
      continue;
    }
    next[id] = {
      ...node,
      permission: minPermissionLevel(node.permission, newLevel),
      permissionNeedsDowngrade: true,
    };
  }
  return next;
}

/**
 * 父窗口关闭：子窗口保留，标记 parentClosed；权限封顶仍按其当前 permission
 * （开启时已 ≤ 父级，关闭不抬升）。
 */
export function markChildrenParentClosed(
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
  closedParentId: string,
): Record<string, WorkbenchAuthNode> {
  const next: Record<string, WorkbenchAuthNode> = { ...tree };
  for (const [id, node] of Object.entries(tree)) {
    if (node.parentWindowId === closedParentId) {
      next[id] = { ...node, parentClosed: true };
    }
  }
  delete next[closedParentId];
  return next;
}
