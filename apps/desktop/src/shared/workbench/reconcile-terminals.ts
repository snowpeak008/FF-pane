/**
 * 渲染端重载后的 PTY 对账纯函数（T10.2'）：
 * - 布局中有对应 windowId 的存活 PTY → 重新挂回（不 spawn）
 * - 布局中没有的孤儿 PTY → 杀掉
 * - 布局仍写着已死的 terminalId → 清除
 */

import type { ProjectWorkbenchLayout } from "@ff-pane/shared";

/** 对账用的终端快照（与 TerminalInfo 字段对齐的最小集）。 */
export interface TerminalReconcileSnapshot {
  readonly id: string;
  readonly exited: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TerminalReattach {
  readonly windowId: string;
  readonly projectId: string;
  readonly terminalId: string;
}

export interface TerminalClearBinding {
  readonly projectId: string;
  readonly windowId: string;
}

export interface TerminalReconcilePlan {
  readonly reattach: readonly TerminalReattach[];
  readonly orphanTerminalIds: readonly string[];
  readonly clearBindings: readonly TerminalClearBinding[];
}

interface LayoutWindowRef {
  readonly projectId: string;
  readonly windowId: string;
  readonly terminalId: string | undefined;
}

function collectLayoutWindows(
  layouts: Readonly<Record<string, ProjectWorkbenchLayout>>,
): Map<string, LayoutWindowRef> {
  const byWindowId = new Map<string, LayoutWindowRef>();
  for (const layout of Object.values(layouts)) {
    for (const window of Object.values(layout.windows)) {
      byWindowId.set(window.id, {
        projectId: layout.projectId,
        windowId: window.id,
        terminalId: window.terminalId,
      });
    }
  }
  return byWindowId;
}

/**
 * 以主进程仍存活的 PTY 与布局对账，生成挂回 / 杀孤儿 / 清失效绑定计划。
 * 无 windowId 元数据的终端视为非工作台 PTY，不纳入孤儿清理。
 */
export function planTerminalReconcile(
  layouts: Readonly<Record<string, ProjectWorkbenchLayout>>,
  terminals: readonly TerminalReconcileSnapshot[],
): TerminalReconcilePlan {
  const layoutWindows = collectLayoutWindows(layouts);
  const reattach: TerminalReattach[] = [];
  const orphanTerminalIds: string[] = [];
  const claimedWindowIds = new Set<string>();

  for (const terminal of terminals) {
    if (terminal.exited) {
      continue;
    }
    const windowId = terminal.metadata?.["windowId"];
    const projectId = terminal.metadata?.["projectId"];
    if (typeof windowId !== "string" || windowId === "") {
      continue;
    }
    const layoutWindow = layoutWindows.get(windowId);
    if (layoutWindow === undefined) {
      orphanTerminalIds.push(terminal.id);
      continue;
    }
    if (typeof projectId === "string" && projectId !== "" && projectId !== layoutWindow.projectId) {
      orphanTerminalIds.push(terminal.id);
      continue;
    }
    if (claimedWindowIds.has(windowId)) {
      // 同一窗口多个存活 PTY：保留先到者，其余当孤儿
      orphanTerminalIds.push(terminal.id);
      continue;
    }
    claimedWindowIds.add(windowId);
    reattach.push({
      windowId,
      projectId: layoutWindow.projectId,
      terminalId: terminal.id,
    });
  }

  const clearBindings: TerminalClearBinding[] = [];
  for (const layoutWindow of layoutWindows.values()) {
    if (layoutWindow.terminalId === undefined) {
      continue;
    }
    if (claimedWindowIds.has(layoutWindow.windowId)) {
      continue;
    }
    const stillAlive = terminals.some(
      (terminal) => terminal.id === layoutWindow.terminalId && !terminal.exited,
    );
    if (!stillAlive) {
      clearBindings.push({
        projectId: layoutWindow.projectId,
        windowId: layoutWindow.windowId,
      });
    }
  }

  return { reattach, orphanTerminalIds, clearBindings };
}
