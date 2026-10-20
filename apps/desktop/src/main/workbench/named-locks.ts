/**
 * 工作台命名锁（E1）：同一项目里一台机器只能开一个的资源（如 Unity）按名字排队。
 * 只在主进程内存里；应用退出时所有窗口都会结束，锁随之清空。
 * 窗口终端退出或被关闭时放掉它持有的锁并退出排队，下一个排队的窗口拿到锁后由调用方提醒。
 */

export const LOCK_NAME_MAX = 64;
const LOCK_NAME = /^[\p{L}\p{N}._-]{1,64}$/u;

export interface LockEntry {
  readonly name: string;
  readonly holder?: string;
  readonly heldSince?: number;
  readonly waiting: readonly string[];
}

export interface LockGrant {
  readonly projectId: string;
  readonly name: string;
  readonly windowId: string;
}

export type AcquireResult =
  | { readonly state: "held"; readonly reentrant: boolean }
  | { readonly state: "queued"; readonly position: number; readonly holder: string };

export interface NamedLocks {
  acquire(projectId: string, name: string, windowId: string): AcquireResult;
  /** 放锁或退出排队。返回是否真的放了，以及接手的窗口。 */
  release(
    projectId: string,
    name: string,
    windowId: string,
  ): { readonly released: boolean; readonly next?: LockGrant };
  /** 窗口没了：放掉全部持有的锁，退出全部排队。返回因此接手的窗口。 */
  releaseWindow(windowId: string): readonly LockGrant[];
  list(projectId: string): readonly LockEntry[];
  /** 本窗口持有和在等的锁名。 */
  of(windowId: string): {
    readonly holding: readonly string[];
    readonly waiting: readonly string[];
  };
}

export function isLockName(value: unknown): value is string {
  return typeof value === "string" && LOCK_NAME.test(value);
}

interface Slot {
  holder?: string;
  heldSince?: number;
  waiting: string[];
}

export function createNamedLocks(now: () => number = Date.now): NamedLocks {
  const projects = new Map<string, Map<string, Slot>>();

  const slotsOf = (projectId: string): Map<string, Slot> => {
    let slots = projects.get(projectId);
    if (slots === undefined) {
      slots = new Map();
      projects.set(projectId, slots);
    }
    return slots;
  };

  /** 把锁交给下一个排队的窗口；没人排队就删掉这把锁。 */
  const handOff = (projectId: string, name: string, slot: Slot): LockGrant | undefined => {
    const next = slot.waiting.shift();
    if (next === undefined) {
      delete slot.holder;
      delete slot.heldSince;
      slotsOf(projectId).delete(name);
      return undefined;
    }
    slot.holder = next;
    slot.heldSince = now();
    return { projectId, name, windowId: next };
  };

  return {
    acquire(projectId, name, windowId) {
      const slots = slotsOf(projectId);
      const slot = slots.get(name);
      if (slot === undefined || slot.holder === undefined) {
        slots.set(name, { holder: windowId, heldSince: now(), waiting: slot?.waiting ?? [] });
        return { state: "held", reentrant: false };
      }
      if (slot.holder === windowId) {
        return { state: "held", reentrant: true };
      }
      if (!slot.waiting.includes(windowId)) {
        slot.waiting.push(windowId);
      }
      return {
        state: "queued",
        position: slot.waiting.indexOf(windowId) + 1,
        holder: slot.holder,
      };
    },
    release(projectId, name, windowId) {
      const slot = slotsOf(projectId).get(name);
      if (slot === undefined) {
        return { released: false };
      }
      if (slot.holder !== windowId) {
        const index = slot.waiting.indexOf(windowId);
        if (index >= 0) {
          slot.waiting.splice(index, 1);
          return { released: true };
        }
        return { released: false };
      }
      const next = handOff(projectId, name, slot);
      return next !== undefined ? { released: true, next } : { released: true };
    },
    releaseWindow(windowId) {
      const grants: LockGrant[] = [];
      for (const [projectId, slots] of projects) {
        for (const [name, slot] of [...slots]) {
          slot.waiting = slot.waiting.filter((id) => id !== windowId);
          if (slot.holder === windowId) {
            const next = handOff(projectId, name, slot);
            if (next !== undefined) {
              grants.push(next);
            }
          }
        }
      }
      return grants;
    },
    list(projectId) {
      return [...slotsOf(projectId)].map(([name, slot]) => ({
        name,
        ...(slot.holder !== undefined ? { holder: slot.holder } : {}),
        ...(slot.heldSince !== undefined ? { heldSince: slot.heldSince } : {}),
        waiting: [...slot.waiting],
      }));
    },
    of(windowId) {
      const holding: string[] = [];
      const waiting: string[] = [];
      for (const slots of projects.values()) {
        for (const [name, slot] of slots) {
          if (slot.holder === windowId) {
            holding.push(name);
          } else if (slot.waiting.includes(windowId)) {
            waiting.push(name);
          }
        }
      }
      return { holding, waiting };
    },
  };
}
