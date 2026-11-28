/**
 * 监管者收到提醒后没处理好的兜底（T11.1b §5）。
 *
 * 提醒交给在线的监管者后，记下「哪个窗口、什么状态」。过了宽限期，窗口还是同一种状态
 * （卡住、等批准、空闲没汇报），就把这一条交给调用方，调用方直接报给管理者一次。
 * 状态变了或窗口没了就悄悄丢掉。每条只交出一次。只在内存里记，应用重启就清。
 */

export const SUPERVISOR_HANDLE_GRACE_MS = 15 * 60_000;

export interface SupervisorHandleEntry {
  readonly windowId: string;
  readonly managerId: string;
  /** 记下提醒时窗口的状态标记；到点时再算一次，一样才算没处理好。 */
  readonly stateKey: string;
  /** 当时提醒的内容，报管理者时带上。 */
  readonly what: string;
}

export interface SupervisorHandleWatch {
  /** 同一个窗口同一种状态重复记不重置时间；状态变了按新的重新计时。 */
  note(entry: SupervisorHandleEntry): void;
  /** 到点且状态没变的条目。到点的都会移除，状态变了的不交出。 */
  takeDue(
    currentStateKey: (windowId: string) => string | undefined,
  ): readonly SupervisorHandleEntry[];
  forget(windowId: string): void;
}

export function createSupervisorHandleWatch(deps: {
  readonly now: () => number;
  readonly graceMs?: number;
}): SupervisorHandleWatch {
  const grace = deps.graceMs ?? SUPERVISOR_HANDLE_GRACE_MS;
  const pending = new Map<string, { readonly entry: SupervisorHandleEntry; readonly at: number }>();
  return {
    note(entry) {
      const existing = pending.get(entry.windowId);
      if (existing !== undefined && existing.entry.stateKey === entry.stateKey) {
        return;
      }
      pending.set(entry.windowId, { entry, at: deps.now() });
    },
    takeDue(currentStateKey) {
      const now = deps.now();
      const due: SupervisorHandleEntry[] = [];
      for (const [windowId, item] of [...pending]) {
        if (now - item.at < grace) {
          continue;
        }
        pending.delete(windowId);
        if (currentStateKey(windowId) === item.entry.stateKey) {
          due.push(item.entry);
        }
      }
      return due;
    },
    forget(windowId) {
      pending.delete(windowId);
    },
  };
}

/** 报给管理者的一句话，以「[状态]」开头。 */
export function buildSupervisorUnhandledLine(
  title: string,
  windowId: string,
  what: string,
): string {
  return `[状态] ${title}（${windowId}）的状态监管者收到 15 分钟了，窗口还是老样子，没见处理：${what} 请你看一下，或用 ffpane_nudge 叫醒监管者。`;
}
