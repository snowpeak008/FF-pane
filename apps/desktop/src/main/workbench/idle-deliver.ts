/**
 * 空闲才投递（T10.6'，T10.7 复用）。
 *
 * 投递原则（无例外）：
 * - 永不强制写入。
 * - 向该终端提交过回车（用户按 Enter，或本队列写出的 \r）后记为忙。
 *   正在等权限确认时保持阻塞，提交回车也不会把它改成忙。
 * - 回合结束（Claude Stop，或 Codex notify 的 agent-turn-complete 映射成的 Stop）后记为空闲。
 * - 自动投递只在已经空闲、输入静默、输出静默同时成立时发生。
 * - 启动后还没收到过回合结束：状态未知，不自动投递，界面给出“立即发送 / 取消”。
 * - PermissionRequest 等待中绝不投递（含用户点“立即发送”）。
 * - 正文不含换行；正文与回车分两次 write。写出回车后记为忙，下一条要等下一次回合结束。
 * - 手动“立即发送”一次只发队首。其余继续等下一次回合结束或用户再次点击。
 * - PermissionRequest 使未决权限计数 +1。计数 > 0 时 Stop 与“立即发送”都不写入。
 *   有合法 tool_use_id 时用它配对，对应的 PostToolUse / PostToolUseFailure 才 −1。
 *   没有 id 的摘要只加不减：同摘要的 PostToolUse 不再把多重集减到 0。
 *   摘要计数只有用户再提交一次输入（UserPromptSubmit）或窗口重启才清。
 *   因此批准权限后的自动提醒会停住，直到用户再发一句。
 *   伪造的 Stop 在计数 > 0 时不解锁。id 配对减到 0 后记为 busy，还要再等一次 Stop 才投递。
 */

export const DEFAULT_OUTPUT_QUIET_MS = 1500;
export const DEFAULT_INPUT_QUIET_MS = 1500;
export const DEFAULT_IDLE_POLL_MS = 200;

export type DeliverPhase = "unknown" | "idle" | "busy" | "blocked";

/** 主进程已归一化的 hook 信号。 */
export type HookSignal =
  | "stop"
  | "permission-request"
  | "user-prompt-submit"
  | "session-start"
  | "post-tool-use"
  | "post-tool-use-failure";

export type IdleDeliverHold = "auto" | "manual" | "blocked" | "busy";

export type DeliverPendingMode = "manual" | "blocked" | "busy" | "clear";

export interface IdleDeliverOutcome {
  readonly terminalId: string;
  readonly status: "delivered" | "dropped";
  readonly reason?: "exited" | "invalid" | "write-failed" | "cancelled";
  readonly tag?: string;
}

export interface DeliverPendingNotice {
  readonly terminalId: string;
  readonly windowId?: string;
  readonly count: number;
  readonly mode: DeliverPendingMode;
}

export interface IdleDeliverDeps {
  readonly isIdle: (terminalId: string, quietMs: number) => boolean;
  readonly isAlive: (terminalId: string) => boolean;
  readonly write: (terminalId: string, data: string) => void;
  readonly now: () => number;
  readonly schedule: (delayMs: number, fn: () => void) => () => void;
  /** 排队之后才发生的结果。立即完成的结果由 enqueue 返回值表达。 */
  readonly onDeferred?: (outcome: IdleDeliverOutcome) => void;
  /** 待投递条数变化（手动确认 / 权限阻塞 / 清空）。 */
  readonly onPending?: (notice: DeliverPendingNotice) => void;
  readonly outputQuietMs?: number;
  readonly inputQuietMs?: number;
  readonly pollMs?: number;
}

export interface IdleDeliverEnqueue {
  readonly terminalId: string;
  readonly text: string;
  /** 调用方标记（窗口 id），随延后结果原样带回。 */
  readonly tag?: string;
  readonly quietMs?: number;
  /** 收件箱提醒。同一终端未投递的提醒合并成一条。 */
  readonly inboxCount?: number;
}

export type IdleDeliverEnqueueResult =
  | { readonly status: "queued"; readonly mode: IdleDeliverHold }
  | { readonly status: "delivered" }
  | { readonly status: "dropped"; readonly reason: "exited" | "invalid" | "write-failed" };

export type ManualDeliverResult =
  | { readonly status: "delivered"; readonly count: number }
  | { readonly status: "refused"; readonly reason: "blocked" | "busy" | "empty" | "dead" };

export interface IdleDeliverAttachOptions {
  /** 启动参数里带了 initialPrompt：SessionStart 不能当成“在等输入”。 */
  readonly initialPrompt?: boolean;
  readonly windowId?: string;
}

/** hook 上报里只带配对用的 id 或摘要，不带工具正文。 */
export interface HookNoteMeta {
  readonly toolUseId?: string;
  readonly toolDigest?: string;
  /** 批准已经被拒绝或取消，这一轮确实结束了，可以放开权限闩。 */
  readonly releasePermissions?: boolean;
}

export interface IdleDeliverQueue {
  attach(terminalId: string, options?: IdleDeliverAttachOptions): void;
  noteHook(terminalId: string, signal: HookSignal, meta?: HookNoteMeta): void;
  noteInput(terminalId: string, atMs?: number): void;
  /** 本窗口向 PTY 提交了回车。不刷新 lastInputAt（由 noteInput 负责）。 */
  noteSubmit(terminalId: string): void;
  enqueue(input: IdleDeliverEnqueue): IdleDeliverEnqueueResult;
  /** 新消息提醒。队列里已有未投递提醒时，用 textForCount(新条数) 替换那一条。 */
  enqueueInbox(
    terminalId: string,
    textForCount: (count: number) => string,
  ): IdleDeliverEnqueueResult;
  /** 仅未知状态（或已经是回合结束）允许用户立即发送。阻塞 / 忙时拒绝。 */
  deliverNow(terminalId: string): ManualDeliverResult;
  cancel(terminalId: string): void;
  /** 窗口退出：清空该终端队列，不再写入。 */
  drop(terminalId: string): void;
  pendingCount(terminalId: string): number;
  phaseOf(terminalId: string): DeliverPhase;
  dispose(): void;
}

interface QueuedItem {
  readonly text: string;
  readonly quietMs: number;
  readonly tag?: string;
  readonly inboxCount?: number;
}

interface Session {
  phase: DeliverPhase;
  /** 能按 tool_use_id 配对的未决权限。 */
  pendingPermissionIds: Set<string>;
  /** 没有 id 时按摘要计入的多重集。同一次输入可以叠多次。 */
  pendingPermissionDigests: Map<string, number>;
  /** 没有 id 也没有摘要、无法配对的未决权限。只由用户新提交或窗口重启清零。 */
  unpairedPermissions: number;
  initialPromptPending: boolean;
  lastInputAt: number;
  windowId?: string;
  queue: QueuedItem[];
}

const TOOL_USE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOOL_DIGEST = /^[a-f0-9]{64}$/;

function cleanToolUseId(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return TOOL_USE_ID.test(trimmed) ? trimmed : undefined;
}

function cleanToolDigest(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return TOOL_DIGEST.test(trimmed) ? trimmed : undefined;
}

function digestOutstanding(session: Session): number {
  let total = 0;
  for (const count of session.pendingPermissionDigests.values()) {
    total += count;
  }
  return total;
}

function permissionOutstanding(session: Session): number {
  return (
    session.pendingPermissionIds.size + digestOutstanding(session) + session.unpairedPermissions
  );
}

function isSingleLine(text: string): boolean {
  return text.length > 0 && !text.includes("\n") && !text.includes("\r");
}

function pendingMode(phase: DeliverPhase): DeliverPendingMode {
  if (phase === "unknown") {
    return "manual";
  }
  if (phase === "blocked") {
    return "blocked";
  }
  if (phase === "busy") {
    return "busy";
  }
  return "clear";
}

function holdMode(phase: DeliverPhase): IdleDeliverHold {
  if (phase === "unknown") {
    return "manual";
  }
  if (phase === "blocked") {
    return "blocked";
  }
  if (phase === "busy") {
    return "busy";
  }
  return "auto";
}

export function createIdleDeliverQueue(deps: IdleDeliverDeps): IdleDeliverQueue {
  const sessions = new Map<string, Session>();
  const timers = new Map<string, () => void>();
  const outputQuietDefault = deps.outputQuietMs ?? DEFAULT_OUTPUT_QUIET_MS;
  const inputQuietMs = deps.inputQuietMs ?? DEFAULT_INPUT_QUIET_MS;
  const pollMs = deps.pollMs ?? DEFAULT_IDLE_POLL_MS;

  const ensure = (terminalId: string): Session => {
    const existing = sessions.get(terminalId);
    if (existing !== undefined) {
      return existing;
    }
    const created: Session = {
      phase: "unknown",
      pendingPermissionIds: new Set(),
      pendingPermissionDigests: new Map(),
      unpairedPermissions: 0,
      initialPromptPending: false,
      lastInputAt: 0,
      queue: [],
    };
    sessions.set(terminalId, created);
    return created;
  };

  const cancelTimer = (terminalId: string): void => {
    const cancel = timers.get(terminalId);
    if (cancel !== undefined) {
      cancel();
      timers.delete(terminalId);
    }
  };

  const notifyPending = (terminalId: string): void => {
    const session = sessions.get(terminalId);
    const count = session?.queue.length ?? 0;
    const mode = session === undefined || count === 0 ? "clear" : pendingMode(session.phase);
    deps.onPending?.({
      terminalId,
      ...(session?.windowId !== undefined ? { windowId: session.windowId } : {}),
      count,
      mode,
    });
  };

  const arm = (terminalId: string): void => {
    if (timers.has(terminalId)) {
      return;
    }
    const cancel = deps.schedule(pollMs, () => {
      timers.delete(terminalId);
      pump(terminalId, true);
    });
    timers.set(terminalId, cancel);
  };

  const finishDropped = (
    terminalId: string,
    reason: "exited" | "write-failed" | "cancelled",
    notify: boolean,
  ): void => {
    const session = sessions.get(terminalId);
    const pending = session?.queue ?? [];
    if (session !== undefined) {
      session.queue = [];
    }
    cancelTimer(terminalId);
    notifyPending(terminalId);
    if (!notify || pending.length === 0) {
      return;
    }
    const tag = pending[0]?.tag;
    deps.onDeferred?.({
      terminalId,
      status: "dropped",
      reason,
      ...(tag !== undefined ? { tag } : {}),
    });
  };

  const canAuto = (terminalId: string, session: Session, quietMs: number): boolean => {
    if (session.phase !== "idle" || permissionOutstanding(session) > 0) {
      return false;
    }
    if (session.lastInputAt !== 0 && deps.now() - session.lastInputAt < inputQuietMs) {
      return false;
    }
    return deps.isIdle(terminalId, quietMs);
  };

  const writeItem = (terminalId: string, item: QueuedItem): boolean => {
    try {
      deps.write(terminalId, item.text);
      deps.write(terminalId, "\r");
      return true;
    } catch {
      return false;
    }
  };

  const deliverHead = (terminalId: string, notify: boolean): boolean => {
    const session = sessions.get(terminalId);
    const item = session?.queue[0];
    if (session === undefined || item === undefined) {
      return false;
    }
    if (!writeItem(terminalId, item)) {
      finishDropped(terminalId, "write-failed", notify);
      return false;
    }
    if (session.phase !== "blocked") {
      session.phase = "busy";
    }
    session.queue.shift();
    if (notify) {
      deps.onDeferred?.({
        terminalId,
        status: "delivered",
        ...(item.tag !== undefined ? { tag: item.tag } : {}),
      });
    }
    notifyPending(terminalId);
    if (session.queue.length > 0) {
      arm(terminalId);
    } else {
      cancelTimer(terminalId);
    }
    return true;
  };

  const pump = (terminalId: string, deferred: boolean): IdleDeliverEnqueueResult | undefined => {
    const session = sessions.get(terminalId);
    const item = session?.queue[0];
    if (session === undefined || item === undefined) {
      cancelTimer(terminalId);
      return undefined;
    }
    if (!deps.isAlive(terminalId)) {
      finishDropped(terminalId, "exited", deferred);
      return { status: "dropped", reason: "exited" };
    }
    if (!canAuto(terminalId, session, item.quietMs)) {
      arm(terminalId);
      notifyPending(terminalId);
      return { status: "queued", mode: holdMode(session.phase) };
    }
    const wrote = deliverHead(terminalId, deferred);
    if (!wrote) {
      return { status: "dropped", reason: "write-failed" };
    }
    return { status: "delivered" };
  };

  return {
    attach(terminalId, options) {
      const session = ensure(terminalId);
      if (options?.windowId !== undefined && options.windowId.trim() !== "") {
        session.windowId = options.windowId;
      }
      if (options?.initialPrompt === true) {
        session.initialPromptPending = true;
      }
    },
    noteHook(terminalId, signal, meta) {
      const session = ensure(terminalId);
      const toolUseId = cleanToolUseId(meta?.toolUseId);
      const toolDigest = cleanToolDigest(meta?.toolDigest);
      if (signal === "permission-request") {
        if (toolUseId !== undefined) {
          session.pendingPermissionIds.add(toolUseId);
        } else if (toolDigest !== undefined) {
          const count = session.pendingPermissionDigests.get(toolDigest) ?? 0;
          session.pendingPermissionDigests.set(toolDigest, count + 1);
        } else {
          session.unpairedPermissions += 1;
        }
        session.phase = "blocked";
      } else if (signal === "post-tool-use" || signal === "post-tool-use-failure") {
        if (toolUseId !== undefined) {
          session.pendingPermissionIds.delete(toolUseId);
        }
        session.phase = permissionOutstanding(session) > 0 ? "blocked" : "busy";
      } else if (signal === "user-prompt-submit") {
        session.pendingPermissionIds.clear();
        session.pendingPermissionDigests.clear();
        session.unpairedPermissions = 0;
        session.initialPromptPending = false;
        session.phase = "busy";
      } else if (signal === "stop") {
        if (meta?.releasePermissions === true) {
          session.pendingPermissionIds.clear();
          session.pendingPermissionDigests.clear();
          session.unpairedPermissions = 0;
        }
        if (permissionOutstanding(session) > 0) {
          session.phase = "blocked";
          notifyPending(terminalId);
          return;
        }
        session.initialPromptPending = false;
        session.phase = "idle";
      } else if (
        signal === "session-start" &&
        session.phase === "unknown" &&
        !session.initialPromptPending &&
        permissionOutstanding(session) === 0
      ) {
        session.phase = "idle";
      }
      if (session.queue.length > 0) {
        pump(terminalId, true);
      } else {
        notifyPending(terminalId);
      }
    },
    noteInput(terminalId, atMs) {
      const session = ensure(terminalId);
      session.lastInputAt = atMs ?? deps.now();
    },
    noteSubmit(terminalId) {
      const session = ensure(terminalId);
      if (session.phase !== "blocked") {
        session.phase = "busy";
      }
      if (session.queue.length > 0) {
        notifyPending(terminalId);
        arm(terminalId);
      }
    },
    enqueue(input) {
      if (!isSingleLine(input.text)) {
        return { status: "dropped", reason: "invalid" };
      }
      if (!deps.isAlive(input.terminalId)) {
        return { status: "dropped", reason: "exited" };
      }
      const session = ensure(input.terminalId);
      if (input.tag !== undefined && session.windowId === undefined) {
        session.windowId = input.tag;
      }
      const item: QueuedItem = {
        text: input.text,
        quietMs: input.quietMs ?? outputQuietDefault,
        ...(input.tag !== undefined ? { tag: input.tag } : {}),
        ...(input.inboxCount !== undefined ? { inboxCount: input.inboxCount } : {}),
      };
      session.queue.push(item);
      if (session.queue.length > 1) {
        notifyPending(input.terminalId);
        arm(input.terminalId);
        return { status: "queued", mode: holdMode(session.phase) };
      }
      const pumped = pump(input.terminalId, false);
      return pumped ?? { status: "queued", mode: holdMode(session.phase) };
    },
    enqueueInbox(terminalId, textForCount) {
      if (!deps.isAlive(terminalId)) {
        return { status: "dropped", reason: "exited" };
      }
      const session = ensure(terminalId);
      const index = session.queue.findIndex((item) => item.inboxCount !== undefined);
      const nextCount = index >= 0 ? (session.queue[index]?.inboxCount ?? 1) + 1 : 1;
      const text = textForCount(nextCount);
      if (!isSingleLine(text)) {
        return { status: "dropped", reason: "invalid" };
      }
      if (index >= 0) {
        const prev = session.queue[index];
        if (prev === undefined) {
          return { status: "dropped", reason: "invalid" };
        }
        session.queue[index] = { ...prev, text, inboxCount: nextCount };
        notifyPending(terminalId);
        return { status: "queued", mode: holdMode(session.phase) };
      }
      return this.enqueue({ terminalId, text, inboxCount: nextCount });
    },
    deliverNow(terminalId) {
      const session = sessions.get(terminalId);
      if (session === undefined || session.queue.length === 0) {
        return { status: "refused", reason: "empty" };
      }
      if (permissionOutstanding(session) > 0 || session.phase === "blocked") {
        if (permissionOutstanding(session) > 0) {
          session.phase = "blocked";
        }
        return { status: "refused", reason: "blocked" };
      }
      if (session.phase === "busy") {
        return { status: "refused", reason: "busy" };
      }
      if (!deps.isAlive(terminalId)) {
        finishDropped(terminalId, "exited", true);
        return { status: "refused", reason: "dead" };
      }
      const wrote = deliverHead(terminalId, true);
      if (!wrote) {
        return { status: "refused", reason: "dead" };
      }
      return { status: "delivered", count: 1 };
    },
    cancel(terminalId) {
      finishDropped(terminalId, "cancelled", true);
    },
    drop(terminalId) {
      finishDropped(terminalId, "exited", true);
      sessions.delete(terminalId);
    },
    pendingCount(terminalId) {
      return sessions.get(terminalId)?.queue.length ?? 0;
    },
    phaseOf(terminalId) {
      return sessions.get(terminalId)?.phase ?? "unknown";
    },
    dispose() {
      for (const terminalId of [...sessions.keys()]) {
        this.drop(terminalId);
      }
      for (const cancel of timers.values()) {
        cancel();
      }
      timers.clear();
    },
  };
}
