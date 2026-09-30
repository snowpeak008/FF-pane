/**
 * 工作台 AI 窗口权威注册表（T10.5'）：主进程内存。
 * 布局读写时同步；launch-cli 按此封顶。父子关系不接受 renderer 传入。
 */

import {
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
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  isWorkbenchPermissionLevel,
  parseWorkbenchOpenedBy,
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
    ...(window.role !== undefined ? { role: window.role } : {}),
    ...(node.parentWindowId !== undefined ? { parentWindowId: node.parentWindowId } : {}),
    ...(node.parentClosed === true ? { parentClosed: true } : {}),
    ...(node.permissionNeedsDowngrade === true ? { permissionNeedsDowngrade: true } : {}),
  };
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
    authInput[window.id] = {
      id: window.id,
      permission: base.permission,
      openedBy,
      ...(existing?.parentWindowId !== undefined
        ? { parentWindowId: existing.parentWindowId }
        : {}),
      ...(existing?.parentClosed === true || base.parentClosed === true
        ? { parentClosed: true }
        : {}),
      ...(base.permissionNeedsDowngrade === true ? { permissionNeedsDowngrade: true } : {}),
    };
  }
  return authInput;
}

export interface WorkbenchAuthRegistry {
  /** 用布局窗口表重建本项目登记（先剥离伪造父级，再 sanitize）。返回清洗后的布局。 */
  syncLayout(layout: ProjectWorkbenchLayout): ProjectWorkbenchLayout;
  /** 登记 / 更新单个 AI 窗口（T10.7 开子窗时由主进程调用）。 */
  upsert(node: WorkbenchAuthNode, projectId: ProjectId): void;
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
  clear(): void;
}

export function createWorkbenchAuthRegistry(): WorkbenchAuthRegistry {
  const byId = new Map<string, StoredAuthNode>();

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

      const nextWindows: Record<string, WorkbenchWindow> = {};
      for (const [id, window] of Object.entries(layout.windows)) {
        const node = sanitized.windows[id];
        nextWindows[id] = node !== undefined ? applyAuthNode(window, node) : window;
      }
      return { ...layout, windows: nextWindows };
    },
    upsert(node, projectId) {
      byId.set(node.id, { ...node, projectId });
    },
    remove(windowId) {
      byId.delete(windowId);
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
    clear() {
      byId.clear();
    },
  };
}
