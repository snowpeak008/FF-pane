/**
 * 主进程 setWindowRole（T10.6）。
 * 界面与未来的 ffpane_set_role 都调用它；内部用 canSetRole 裁决。
 * 正在运行的窗口不重启：空闲队列投递一行说明；下次启动再走系统提示。
 */

import { canSetRole, type WorkbenchAuthActor } from "@ff-pane/core";
import {
  DEFAULT_WORKBENCH_ROLE,
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  isWorkbenchPermissionLevel,
  isWorkbenchRole,
  type ProjectWorkbenchLayout,
  type WorkbenchRole,
  type WorkbenchWindow,
} from "@ff-pane/shared";
import type { WorkbenchAuthRegistry } from "./auth-registry";
import type { IdleDeliverQueue } from "./idle-deliver";
import { buildRoleSwitchLine } from "./role-manuals";

export interface SetWindowRoleDeps {
  readonly authRegistry: WorkbenchAuthRegistry;
  readonly readLayouts: () => Promise<Readonly<Record<string, ProjectWorkbenchLayout>>>;
  readonly saveLayout: (layout: ProjectWorkbenchLayout) => Promise<void>;
  /** 该窗口当前存活的 PTY id；没有则不投递。 */
  readonly findLiveTerminalId: (windowId: string) => string | undefined;
  readonly idleQueue: IdleDeliverQueue;
  readonly manualPath: (role: WorkbenchRole) => Promise<string>;
}

export type SetWindowRoleResult =
  | {
      readonly ok: true;
      readonly role: WorkbenchRole;
      readonly delivery: "skipped" | "queued" | "manual" | "held" | "delivered" | "dropped";
    }
  | { readonly ok: false; readonly reason: "unknown-window" | "forbidden" | "invalid-role" };

function ensureAuthNode(registry: WorkbenchAuthRegistry, window: WorkbenchWindow): void {
  if (window.kind !== "claude" && window.kind !== "codex") {
    return;
  }
  if (registry.get(window.id) !== undefined) {
    return;
  }
  registry.upsert(
    {
      id: window.id,
      permission: isWorkbenchPermissionLevel(window.permission)
        ? window.permission
        : DEFAULT_WORKBENCH_WINDOW_PERMISSION,
      openedBy: window.openedBy ?? "user",
      role: isWorkbenchRole(window.role) ? window.role : DEFAULT_WORKBENCH_ROLE,
      ...(window.parentWindowId !== undefined && window.parentWindowId.trim() !== ""
        ? { parentWindowId: window.parentWindowId }
        : {}),
      ...(window.parentClosed === true ? { parentClosed: true } : {}),
    },
    window.projectId,
  );
}

export async function setWindowRole(
  actor: WorkbenchAuthActor,
  windowId: string,
  role: WorkbenchRole,
  deps: SetWindowRoleDeps,
): Promise<SetWindowRoleResult> {
  if (!isWorkbenchRole(role)) {
    return { ok: false, reason: "invalid-role" };
  }
  const layouts = await deps.readLayouts();
  let found:
    | { readonly layout: ProjectWorkbenchLayout; readonly window: WorkbenchWindow }
    | undefined;
  for (const layout of Object.values(layouts)) {
    const window = layout.windows[windowId];
    if (window !== undefined) {
      found = { layout, window };
      break;
    }
  }
  if (found === undefined) {
    const node = deps.authRegistry.get(windowId);
    if (node === undefined) {
      return { ok: false, reason: "unknown-window" };
    }
    const allowed = canSetRole(
      actor,
      {
        id: windowId,
        openedBy: node.openedBy,
        ...(node.parentWindowId !== undefined ? { parentWindowId: node.parentWindowId } : {}),
      },
      role,
      deps.authRegistry.snapshot(),
    );
    if (!allowed) {
      return { ok: false, reason: "forbidden" };
    }
    if (!deps.authRegistry.setRole(windowId, role)) {
      return { ok: false, reason: "unknown-window" };
    }
    return deliverRoleSwitch(windowId, role, deps);
  }

  const isAi = found.window.kind === "claude" || found.window.kind === "codex";
  if (isAi) {
    ensureAuthNode(deps.authRegistry, found.window);
  }
  const tree = deps.authRegistry.snapshot();
  const allowed = canSetRole(
    actor,
    {
      id: found.window.id,
      ...(found.window.openedBy !== undefined ? { openedBy: found.window.openedBy } : {}),
      ...(found.window.parentWindowId !== undefined
        ? { parentWindowId: found.window.parentWindowId }
        : {}),
    },
    role,
    tree,
  );
  if (!allowed) {
    return { ok: false, reason: "forbidden" };
  }
  if (isAi && !deps.authRegistry.setRole(windowId, role)) {
    return { ok: false, reason: "unknown-window" };
  }

  const nextWindow: WorkbenchWindow = { ...found.window, role };
  await deps.saveLayout({
    ...found.layout,
    windows: { ...found.layout.windows, [windowId]: nextWindow },
  });

  if (!isAi) {
    return { ok: true, role, delivery: "skipped" };
  }
  return deliverRoleSwitch(windowId, role, deps);
}

async function deliverRoleSwitch(
  windowId: string,
  role: WorkbenchRole,
  deps: SetWindowRoleDeps,
): Promise<SetWindowRoleResult> {
  const terminalId = deps.findLiveTerminalId(windowId);
  if (terminalId === undefined) {
    return { ok: true, role, delivery: "skipped" };
  }
  const manualPath = await deps.manualPath(role);
  const line = buildRoleSwitchLine(role, manualPath);
  const queued = deps.idleQueue.enqueue({
    terminalId,
    text: line,
    tag: windowId,
  });
  if (queued.status === "queued") {
    if (queued.mode === "manual") {
      return { ok: true, role, delivery: "manual" };
    }
    if (queued.mode === "blocked" || queued.mode === "busy") {
      return { ok: true, role, delivery: "held" };
    }
    return { ok: true, role, delivery: "queued" };
  }
  if (queued.status === "dropped") {
    return { ok: true, role, delivery: "dropped" };
  }
  return { ok: true, role, delivery: "delivered" };
}
