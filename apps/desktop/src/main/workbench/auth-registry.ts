/**
 * 工作台 AI 窗口权威注册表（T10.5'）：主进程内存。
 * 布局读写时同步；launch-cli 按此封顶。父子关系不接受 renderer 传入。
 */

import {
  markChildrenParentClosed,
  resolveLaunchPermission,
  sanitizeWorkbenchAuthTree,
  type WorkbenchAuthNode,
} from "@ff-pane/core";
import type {
  ProjectId,
  ProjectWorkbenchLayout,
  WorkbenchPermissionLevel,
  WorkbenchWindow,
} from "@ff-pane/shared";
import {
  DEFAULT_WORKBENCH_ROLE,
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  isWorkbenchPermissionLevel,
  isWorkbenchRole,
  minPermissionLevel,
  parseWorkbenchOpenedBy,
  type WorkbenchRole,
} from "@ff-pane/shared";

interface StoredAuthNode extends WorkbenchAuthNode {
  readonly projectId: ProjectId;
}

function toAuthNode(window: WorkbenchWindow): WorkbenchAuthNode | undefined {
  if (window.kind !== "claude" && window.kind !== "codex") {
    return undefined;
  }
  return {
    id: window.id,
    permission: isWorkbenchPermissionLevel(window.permission)
      ? window.permission
      : DEFAULT_WORKBENCH_WINDOW_PERMISSION,
    openedBy: window.openedBy !== undefined ? parseWorkbenchOpenedBy(window.openedBy) : "user",
    ...(window.parentWindowId !== undefined && window.parentWindowId.trim() !== ""
      ? { parentWindowId: window.parentWindowId }
      : {}),
    ...(window.parentClosed === true ? { parentClosed: true } : {}),
    ...(window.permissionNeedsDowngrade === true ? { permissionNeedsDowngrade: true } : {}),
    role: isWorkbenchRole(window.role) ? window.role : DEFAULT_WORKBENCH_ROLE,
  };
}

function applyAuthNode(window: WorkbenchWindow, node: WorkbenchAuthNode): WorkbenchWindow {
  return {
    id: window.id,
    projectId: window.projectId,
    title: window.title,
    kind: window.kind,
    cwd: window.cwd,
    createdAt: window.createdAt,
    permission: node.permission,
    openedBy: node.openedBy,
    ...(window.terminalId !== undefined ? { terminalId: window.terminalId } : {}),
    ...(window.profileId !== undefined ? { profileId: window.profileId } : {}),
    ...(window.nativeSessionId !== undefined ? { nativeSessionId: window.nativeSessionId } : {}),
    role: node.role ?? (isWorkbenchRole(window.role) ? window.role : DEFAULT_WORKBENCH_ROLE),
    ...(node.parentWindowId !== undefined ? { parentWindowId: node.parentWindowId } : {}),
    ...(node.parentClosed === true ? { parentClosed: true } : {}),
    ...(node.permissionNeedsDowngrade === true ? { permissionNeedsDowngrade: true } : {}),
  };
}

/** 有父级的 manager 在本进程尚未被授予时，标题栏显示待恢复。该标记不是授权。 */
function withGrantPending(
  window: WorkbenchWindow,
  node: WorkbenchAuthNode,
  granted: boolean,
): WorkbenchWindow {
  const applied = applyAuthNode(window, node);
  const hasParent = node.parentWindowId !== undefined && node.parentWindowId.trim() !== "";
  if (node.role === "manager" && hasParent && !granted) {
    return { ...applied, managerGrantPending: true };
  }
  return applied;
}

/**
 * 合并 renderer 布局与权威登记：父子关系只认主进程已登记的 parent；
 * renderer 传入的 parentWindowId 一律忽略（防伪造 / 清父提权）。
 */
function mergeRendererLayout(
  layout: ProjectWorkbenchLayout,
  existingById: ReadonlyMap<string, StoredAuthNode>,
): Record<string, WorkbenchAuthNode> {
  const authInput: Record<string, WorkbenchAuthNode> = {};
  for (const window of Object.values(layout.windows)) {
    const base = toAuthNode(window);
    if (base === undefined) {
      continue;
    }
    const existing = existingById.get(window.id);
    const openedBy = existing?.openedBy ?? base.openedBy;
    const role = existing?.role ?? base.role ?? DEFAULT_WORKBENCH_ROLE;
    const locked = existing?.sanitizeLocked === true;
    const permission =
      existing !== undefined
        ? minPermissionLevel(existing.permission, base.permission)
        : base.permission;
    authInput[window.id] = {
      id: window.id,
      permission,
      openedBy,
      role,
      ...(existing?.parentWindowId !== undefined
        ? { parentWindowId: existing.parentWindowId }
        : {}),
      ...(existing?.parentClosed === true || base.parentClosed === true
        ? { parentClosed: true }
        : {}),
      ...(locked ||
      existing?.permissionNeedsDowngrade === true ||
      base.permissionNeedsDowngrade === true
        ? { permissionNeedsDowngrade: true }
        : {}),
      ...(locked ? { sanitizeLocked: true } : {}),
      ...(existing?.userElevated === true ? { userElevated: true } : {}),
      ...(existing?.userRoleSet === true ? { userRoleSet: true } : {}),
    };
  }
  return authInput;
}

export interface WorkbenchAuthRegistry {
  /** 用布局窗口表重建本项目登记（先剥离伪造父级，再 sanitize）。返回清洗后的布局。 */
  syncLayout(layout: ProjectWorkbenchLayout): ProjectWorkbenchLayout;
  /**
   * 冷启动：按磁盘上的父子关系重建登记，断环后再按祖先封顶。
   * 不把磁盘权限当成顶层用户授权，也不授予 manager。
   */
  restoreColdLayout(layout: ProjectWorkbenchLayout): ProjectWorkbenchLayout;
  hasProject(projectId: ProjectId): boolean;
  /** 关闭窗口：直接子级标记 parentClosed，自身移出登记并吊销管理权授予。 */
  closeRegistered(windowId: string): void;
  /** 登记 / 更新单个 AI 窗口（T10.7 开子窗时由主进程调用）。 */
  upsert(node: WorkbenchAuthNode, projectId: ProjectId): void;
  /**
   * 开子窗口：先登记并钉住。随后若 renderer 用旧布局 sync，也不会把父级丢掉。
   * launch 成功且布局已含该窗口后再 unpin。
   */
  pin(node: WorkbenchAuthNode, projectId: ProjectId): void;
  unpin(windowId: string): void;
  /** 本进程里 setWindowRole 设为 manager 才授予开窗口能力。冷读布局不算。 */
  grantManager(windowId: string): void;
  clearManagerGrant(windowId: string): void;
  isManagerGranted(windowId: string): boolean;
  /** 移除。 */
  remove(windowId: string): void;
  get(windowId: string): WorkbenchAuthNode | undefined;
  /** 启动封顶。 */
  resolveLaunch(
    windowId: string,
    requested?: WorkbenchPermissionLevel,
  ): {
    readonly effective: WorkbenchPermissionLevel;
    readonly capped: boolean;
    readonly cycle: boolean;
  };
  snapshot(): Readonly<Record<string, WorkbenchAuthNode>>;
  /** 更新已登记窗口的角色。窗口不存在时返回 false。 */
  setRole(windowId: string, role: WorkbenchRole): boolean;
  /**
   * 界面用户显式改权限。清掉清洗锁，允许高于当前登记值。
   * 有父级时，随后的 sync 仍按祖先封顶。
   */
  applyUserPermission(windowId: string, permission: WorkbenchPermissionLevel): boolean;
  clear(): void;
}

export function createWorkbenchAuthRegistry(): WorkbenchAuthRegistry {
  const byId = new Map<string, StoredAuthNode>();
  const pinned = new Map<string, StoredAuthNode>();
  const managerGranted = new Set<string>();

  const remember = (id: string, node: StoredAuthNode): void => {
    byId.set(id, node);
    if (pinned.has(id)) {
      pinned.set(id, node);
    }
  };

  return {
    syncLayout(layout) {
      const authInput = mergeRendererLayout(layout, byId);
      const sanitized = sanitizeWorkbenchAuthTree(authInput);

      for (const [id, stored] of [...byId.entries()]) {
        if (stored.projectId === layout.projectId) {
          byId.delete(id);
        }
      }
      for (const [id, node] of Object.entries(sanitized.windows)) {
        byId.set(id, { ...node, projectId: layout.projectId });
      }
      for (const [id, node] of pinned) {
        if (node.projectId === layout.projectId) {
          byId.set(id, node);
        }
      }

      const nextWindows: Record<string, WorkbenchWindow> = {};
      for (const [id, window] of Object.entries(layout.windows)) {
        const node = sanitized.windows[id];
        nextWindows[id] =
          node !== undefined
            ? withGrantPending(window, node, managerGranted.has(id) && node.role === "manager")
            : window;
      }
      return { ...layout, windows: nextWindows };
    },
    restoreColdLayout(layout) {
      const authInput: Record<string, WorkbenchAuthNode> = {};
      for (const window of Object.values(layout.windows)) {
        const base = toAuthNode(window);
        if (base !== undefined) {
          authInput[window.id] = base;
        }
      }
      const sanitized = sanitizeWorkbenchAuthTree(authInput);
      for (const [id, stored] of [...byId.entries()]) {
        if (stored.projectId === layout.projectId && !pinned.has(id)) {
          byId.delete(id);
        }
      }
      for (const [id, node] of Object.entries(sanitized.windows)) {
        if (!pinned.has(id)) {
          byId.set(id, { ...node, projectId: layout.projectId });
        }
      }
      for (const [id, node] of pinned) {
        if (node.projectId === layout.projectId) {
          byId.set(id, node);
        }
      }
      const nextWindows: Record<string, WorkbenchWindow> = {};
      for (const [id, window] of Object.entries(layout.windows)) {
        const node = sanitized.windows[id];
        if (node === undefined) {
          nextWindows[id] = window;
          continue;
        }
        const granted = managerGranted.has(id) && node.role === "manager";
        nextWindows[id] = withGrantPending(window, node, granted);
      }
      return { ...layout, windows: nextWindows };
    },
    hasProject(projectId) {
      for (const stored of byId.values()) {
        if (stored.projectId === projectId) {
          return true;
        }
      }
      return false;
    },
    closeRegistered(windowId) {
      const tree: Record<string, WorkbenchAuthNode> = {};
      for (const [id, stored] of byId.entries()) {
        const { projectId: _project, ...node } = stored;
        void _project;
        tree[id] = node;
      }
      const next = markChildrenParentClosed(tree, windowId);
      byId.delete(windowId);
      pinned.delete(windowId);
      managerGranted.delete(windowId);
      for (const [id, node] of Object.entries(next)) {
        const stored = byId.get(id);
        if (stored === undefined || node.parentClosed !== true) {
          continue;
        }
        remember(id, { ...stored, parentClosed: true });
      }
    },
    upsert(node, projectId) {
      remember(node.id, { ...node, projectId });
    },
    pin(node, projectId) {
      const stored = { ...node, projectId };
      pinned.set(node.id, stored);
      byId.set(node.id, stored);
    },
    unpin(windowId) {
      pinned.delete(windowId);
    },
    grantManager(windowId) {
      if (byId.has(windowId)) {
        managerGranted.add(windowId);
      }
    },
    clearManagerGrant(windowId) {
      managerGranted.delete(windowId);
    },
    isManagerGranted(windowId) {
      return managerGranted.has(windowId) && byId.get(windowId)?.role === "manager";
    },
    remove(windowId) {
      byId.delete(windowId);
      pinned.delete(windowId);
      managerGranted.delete(windowId);
    },
    get(windowId) {
      const stored = byId.get(windowId);
      if (stored === undefined) {
        return undefined;
      }
      const { projectId: _p, ...node } = stored;
      void _p;
      return node;
    },
    resolveLaunch(windowId, requested) {
      const tree: Record<string, WorkbenchAuthNode> = {};
      for (const [id, stored] of byId.entries()) {
        const { projectId: _p, ...node } = stored;
        void _p;
        tree[id] = node;
      }
      if (byId.get(windowId) === undefined) {
        const effective = requested ?? DEFAULT_WORKBENCH_WINDOW_PERMISSION;
        return { effective, capped: false, cycle: false };
      }
      return resolveLaunchPermission({
        windowId,
        ...(requested !== undefined ? { requested } : {}),
        tree,
      });
    },
    snapshot() {
      const out: Record<string, WorkbenchAuthNode> = {};
      for (const [id, stored] of byId.entries()) {
        const { projectId: _p, ...node } = stored;
        void _p;
        out[id] = node;
      }
      return out;
    },
    setRole(windowId, role) {
      const stored = byId.get(windowId);
      if (stored === undefined) {
        return false;
      }
      remember(windowId, { ...stored, role, userRoleSet: true });
      return true;
    },
    applyUserPermission(windowId, permission) {
      const stored = byId.get(windowId);
      if (stored === undefined || !isWorkbenchPermissionLevel(permission)) {
        return false;
      }
      const { sanitizeLocked: _locked, permissionNeedsDowngrade: _down, ...rest } = stored;
      void _locked;
      void _down;
      remember(windowId, { ...rest, permission, userElevated: true });
      return true;
    },
    clear() {
      byId.clear();
      pinned.clear();
      managerGranted.clear();
    },
  };
}
