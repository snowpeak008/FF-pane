/**
 * 在线监管（参考 cc-pane 的 wait_for_session）：窗口循环调用 ffpane_wait_events，回合一直不结束，算「在线」。
 *
 * 在线时，本来要打进终端的提醒（状态、锁、投递失败、叫醒）和新消息都交给等待调用：
 * - 正在等：立刻把事件交给它返回；
 * - 两次调用之间（它在处理上一批）：先存着，下次一调用就立刻返回；
 * 回合不结束，打进终端的提醒会一直排队送不到，所以在线时不能走终端。
 * 很久没再调用（超过本次等待时长再加一段处理时间）就算离线，存着的事件交还调用方打进终端，不丢。
 * 用户点「下线」时，通过等待调用告诉它停止，此后的提醒照常走终端。
 */

/** 一次等待的秒数：缺省 240，夹在 10 到 540 之间。sidecar 按同一规则放宽自己的超时。 */
export function clampWaitSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 240;
  }
  return Math.min(540, Math.max(10, Math.floor(value)));
}

/** 等待返回之后，留给它处理这一批再回来等的时间。超过就算离线。 */
export const ONLINE_PROCESSING_GRACE_MS = 5 * 60_000;

export interface WaitOutcome {
  readonly events: readonly string[];
  /** 有新消息，调用方负责把正文附上。 */
  readonly inbox: boolean;
  /** 用户叫停了在线监管。 */
  readonly stop: boolean;
  readonly timedOut: boolean;
}

export interface OfflineBacklog {
  readonly windowId: string;
  readonly events: readonly string[];
  readonly inbox: boolean;
}

export interface OnlineHub {
  wait(windowId: string, timeoutMs: number): Promise<WaitOutcome>;
  /** 在线就收下这条提醒并返回 true；离线返回 false，调用方照常打进终端。 */
  offer(windowId: string, text: string): boolean;
  /** 有新消息。在线就收下并返回 true。 */
  offerInbox(windowId: string): boolean;
  /** 叫停。它在线就返回 true，并在下一次（或正在进行的）等待里告诉它。 */
  requestStop(windowId: string): boolean;
  isOnline(windowId: string): boolean;
  isWaiting(windowId: string): boolean;
  /** 已经离线、但还存着没交出去的事件。取走后清空，由调用方打进终端。 */
  drainOffline(): readonly OfflineBacklog[];
  forget(windowId: string): void;
  dispose(): void;
}

interface Slot {
  onlineUntil: number;
  events: string[];
  inbox: boolean;
  stop: boolean;
  waiter?: { resolve: (outcome: WaitOutcome) => void; cancelTimer: () => void };
}

export function createOnlineHub(deps: {
  readonly now: () => number;
  readonly schedule: (delayMs: number, fn: () => void) => () => void;
  readonly graceMs?: number;
}): OnlineHub {
  const slots = new Map<string, Slot>();
  const grace = deps.graceMs ?? ONLINE_PROCESSING_GRACE_MS;

  const slotOf = (windowId: string): Slot => {
    let slot = slots.get(windowId);
    if (slot === undefined) {
      slot = { onlineUntil: 0, events: [], inbox: false, stop: false };
      slots.set(windowId, slot);
    }
    return slot;
  };

  const online = (slot: Slot | undefined): boolean =>
    slot !== undefined && (slot.waiter !== undefined || deps.now() < slot.onlineUntil);

  /** 把存着的事件交给正在等的调用。 */
  const flush = (slot: Slot, timedOut: boolean): void => {
    const waiter = slot.waiter;
    if (waiter === undefined) {
      return;
    }
    delete slot.waiter;
    waiter.cancelTimer();
    const outcome: WaitOutcome = {
      events: slot.events,
      inbox: slot.inbox,
      stop: slot.stop,
      timedOut,
    };
    slot.events = [];
    slot.inbox = false;
    if (slot.stop) {
      // 叫停已经交到它手里：从此离线，后面的提醒照常走终端。
      slot.stop = false;
      slot.onlineUntil = 0;
    } else {
      slot.onlineUntil = deps.now() + grace;
    }
    waiter.resolve(outcome);
  };

  return {
    wait(windowId, timeoutMs) {
      const slot = slotOf(windowId);
      if (slot.waiter !== undefined) {
        // 同一个窗口重复调用：旧的那次按超时交回。
        flush(slot, true);
      }
      slot.onlineUntil = deps.now() + timeoutMs + grace;
      return new Promise<WaitOutcome>((resolve) => {
        const cancelTimer = deps.schedule(timeoutMs, () => {
          flush(slot, true);
        });
        slot.waiter = { resolve, cancelTimer };
        if (slot.events.length > 0 || slot.inbox || slot.stop) {
          flush(slot, false);
        }
      });
    },
    offer(windowId, text) {
      const slot = slots.get(windowId);
      if (!online(slot) || slot === undefined) {
        return false;
      }
      slot.events.push(text);
      flush(slot, false);
      return true;
    },
    offerInbox(windowId) {
      const slot = slots.get(windowId);
      if (!online(slot) || slot === undefined) {
        return false;
      }
      slot.inbox = true;
      flush(slot, false);
      return true;
    },
    requestStop(windowId) {
      const slot = slots.get(windowId);
      if (!online(slot) || slot === undefined) {
        return false;
      }
      slot.stop = true;
      flush(slot, false);
      return true;
    },
    isOnline(windowId) {
      return online(slots.get(windowId));
    },
    isWaiting(windowId) {
      return slots.get(windowId)?.waiter !== undefined;
    },
    drainOffline() {
      const backlog: OfflineBacklog[] = [];
      for (const [windowId, slot] of slots) {
        if (online(slot) || (slot.events.length === 0 && !slot.inbox)) {
          continue;
        }
        backlog.push({ windowId, events: slot.events, inbox: slot.inbox });
        slot.events = [];
        slot.inbox = false;
        slot.stop = false;
      }
      return backlog;
    },
    forget(windowId) {
      const slot = slots.get(windowId);
      if (slot?.waiter !== undefined) {
        flush(slot, true);
      }
      slots.delete(windowId);
    },
    dispose() {
      for (const windowId of [...slots.keys()]) {
        this.forget(windowId);
      }
    },
  };
}
