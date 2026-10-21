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
 * - 可按终端设回车延迟（submitDelayMs）：Codex 会把紧跟在一串字符后的回车当成粘贴里的换行，
 *   正文写完隔一会儿再写回车。
 * - 可按终端核对提交（verifySubmit）：回车后一段时间里没开始一轮，视为没提交，补一次回车；
 *   仍然没有就报 not-submitted，并转回手动确认。有真信号来源（Codex rollout 的 task_started）时
 *   只认真信号；没有时退回看终端有没有开工输出（干活时加载动画每秒都在刷新）。
 * - 收件箱读空后 dropInbox 撤掉还没投递的提醒，避免已读的消息再提醒一遍。
 * - 启动后还没收到过回合信号时，看到输入提示符（notePromptReady）也算空闲：
 *   重启过的窗口没跑过一轮，等不到 Stop。忙着却长时间安静、屏幕上是空闲的输入框，
 *   多半是上一轮被打断（Esc 不触发 Stop），同样清掉。
 * - 带 allowUnknown 的条目（平台的「继续」）在状态未知时也自动投递，仍要输入、输出都静默。
 * - 每条可带 onSubmit：核对完提交与否后回调一次，调用方据此直接回报成功或失败。
 * - 可按终端用括号粘贴（bracketedPaste）写正文：Claude Code 2.1.302 把一长串中文当成粘贴，
 *   紧跟的回车变成粘贴里的换行，之后单独补的回车也不提交（真机复现，2026-10-21）；
 *   用 ESC[200~ … ESC[201~ 标出粘贴的起止，回车就是回车。
 * - 可按终端设清空输入框的按键（clearInput，Claude 与 Codex 都是 Ctrl+U）：没提交时先清掉、
 *   重新打一遍再回车；还不行就清掉再报 not-submitted。不清的话文字留在输入框里，
 *   下一条提醒接在后面，越堆越多。
 */

export const DEFAULT_OUTPUT_QUIET_MS = 1500;
export const DEFAULT_INPUT_QUIET_MS = 1500;
export const DEFAULT_IDLE_POLL_MS = 200;
export const DEFAULT_SUBMIT_VERIFY_MS = 4000;
/** 回车后这段时间内的输出只算回显和重画，不算开工。 */
export const SUBMIT_ECHO_GRACE_MS = 1500;
/**
 * Codex 正文与回车的间隔。真机实测（codex-cli 0.162.0，约 200 字的提醒行）：
 * 紧跟回车和隔 150ms 都停在输入框；250ms、400ms、800ms 都能提交。取 800ms 留余量。
 */
export const CODEX_SUBMIT_DELAY_MS = 800;
/**
 * 清空输入框：Ctrl+U 删到行首，多按几次把多行也删掉。
 * 真机核对：Claude Code 2.1.302、codex-cli 0.162.0 都能清掉卡住的那段（2026-10-21）。
 */
export const CLEAR_INPUT_KEYS = "\u0015\u0015\u0015\u0015";

export type DeliverPhase = "unknown" | "idle" | "busy" | "blocked";

/**
 * 一条投递最终有没有提交。
 * unverified：这个终端不核对提交（拿不到信号），写出回车就算数。
 * dropped：没写出去（终端退出、取消、写入失败），或核对途中终端没了。
 */
export type SubmitResult = "submitted" | "not-submitted" | "unverified" | "dropped";

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
  readonly reason?: "exited" | "invalid" | "write-failed" | "cancelled" | "not-submitted";
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
  /** 终端最近一次输出的时间。缺省时不核对提交。 */
  readonly lastOutputAt?: (terminalId: string) => number | undefined;
  /**
   * 看屏幕：输入框里是不是还留着这段文字。false = 已经不在了（提交了），true = 还在，undefined = 看不出。
   * 信号说没提交时先看一眼再重打，免得把其实已经提交的再发一遍。
   */
  readonly inputStillHolds?: (terminalId: string, text: string) => Promise<boolean | undefined>;
  readonly submitVerifyMs?: number;
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
  /** 状态未知时也自动投递（仍要静默）。只给平台固定文案用。 */
  readonly allowUnknown?: boolean;
  /** 核对完提交与否后回调一次。 */
  readonly onSubmit?: (result: SubmitResult) => void;
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
  /** 正文与回车之间的间隔。0 表示紧接着写。 */
  readonly submitDelayMs?: number;
  /** 回车后核对是否真的提交了。 */
  readonly verifySubmit?: boolean;
  /** 一开始就有可靠的「一轮开始」信号来源（UserPromptSubmit hook）。 */
  readonly turnStartSource?: boolean;
  /** 正文用括号粘贴写。 */
  readonly bracketedPaste?: boolean;
  /** 清空输入框的按键。没提交时用它清掉再重打，最后也用它收尾。 */
  readonly clearInput?: string;
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
    /** 只在这次新排了一条时挂上；并进已有的那条时不回调。 */
    onSubmit?: (result: SubmitResult) => void,
  ): IdleDeliverEnqueueResult;
  /** 仅未知状态（或已经是回合结束）允许用户立即发送。阻塞 / 忙时拒绝。 */
  deliverNow(terminalId: string): ManualDeliverResult;
  cancel(terminalId: string): void;
  /** 窗口退出：清空该终端队列，不再写入。 */
  drop(terminalId: string): void;
  /** 收件箱已读空：撤掉还没投递的收件箱提醒。返回撤掉的条数。 */
  dropInbox(terminalId: string): number;
  /**
   * 这个终端有了可靠的「一轮开始」信号来源（Codex rollout 的 task_started）。
   * 有来源后，提交核对只认这个信号，不再看终端有没有输出。
   */
  setTurnStartSource(terminalId: string, available: boolean): void;
  /** 一轮开始了：消息确实提交了。 */
  noteTurnStarted(terminalId: string): void;
  /**
   * 屏幕上是空闲的输入提示符。状态未知时判为空闲；
   * settled（输出已经安静很久）时连忙和初始提示也一起清掉。返回状态有没有变成空闲。
   */
  notePromptReady(terminalId: string, options?: { readonly settled?: boolean }): boolean;
  /** 这个终端跑过一轮（提交过回车或收到过回合信号）。 */
  hadTurn(terminalId: string): boolean;
  /** 平台正在这个终端里按键（比如 /model 选择器）：暂停自动投递。 */
  setPaused(terminalId: string, paused: boolean): void;
  pendingCount(terminalId: string): number;
  phaseOf(terminalId: string): DeliverPhase;
  dispose(): void;
}

interface QueuedItem {
  readonly text: string;
  readonly quietMs: number;
  readonly tag?: string;
  readonly inboxCount?: number;
  readonly allowUnknown?: boolean;
  readonly onSubmit?: (result: SubmitResult) => void;
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
  submitDelayMs: number;
  verifySubmit: boolean;
  /** 等写回车或等核对的定时器。 */
  cancelSubmit?: () => void;
  /** 正在核对的那条的回调。被打断时以给定结果回调。 */
  submitWaiter?: (result: SubmitResult) => void;
  /** 提交过回车或收到过回合信号。 */
  hadTurn: boolean;
  paused: boolean;
  bracketedPaste: boolean;
  clearInput?: string;
  /** 有可靠的「一轮开始」信号来源。 */
  turnStartSource: boolean;
  lastTurnStartAt: number;
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
  const submitVerifyMs = deps.submitVerifyMs ?? DEFAULT_SUBMIT_VERIFY_MS;

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
      submitDelayMs: 0,
      verifySubmit: false,
      turnStartSource: false,
      lastTurnStartAt: 0,
      hadTurn: false,
      paused: false,
      bracketedPaste: false,
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
    for (const item of pending) {
      item.onSubmit?.("dropped");
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

  const canAuto = (terminalId: string, session: Session, item: QueuedItem): boolean => {
    const phaseOk =
      session.phase === "idle" || (session.phase === "unknown" && item.allowUnknown === true);
    if (!phaseOk || session.paused || permissionOutstanding(session) > 0) {
      return false;
    }
    if (session.lastInputAt !== 0 && deps.now() - session.lastInputAt < inputQuietMs) {
      return false;
    }
    return deps.isIdle(terminalId, item.quietMs);
  };

  const settleSubmit = (session: Session, result: SubmitResult): void => {
    const waiter = session.submitWaiter;
    delete session.submitWaiter;
    waiter?.(result);
  };

  /** 停掉等回车或等核对的定时器。还在等结果的那条按 result 回调。 */
  const clearSubmit = (session: Session, result: SubmitResult): void => {
    session.cancelSubmit?.();
    delete session.cancelSubmit;
    settleSubmit(session, result);
  };

  /** 回车后核对：有回合信号或开工输出就算提交；否则补一次回车，再不行就报没提交。 */
  const bodyOf = (session: Session, text: string): string =>
    session.bracketedPaste ? `\u001b[200~${text}\u001b[201~` : text;

  /** 打正文，按终端的间隔写回车，再核对。返回正文有没有写出去。 */
  const typeAndEnter = (
    terminalId: string,
    session: Session,
    text: string,
    retried: boolean,
    tag: string | undefined,
  ): boolean => {
    try {
      deps.write(terminalId, bodyOf(session, text));
    } catch {
      return false;
    }
    const enter = (): boolean => {
      try {
        deps.write(terminalId, "\r");
      } catch {
        return false;
      }
      verifyAfterEnter(terminalId, session, deps.now(), retried, tag, text);
      return true;
    };
    if (session.submitDelayMs <= 0) {
      return enter();
    }
    session.cancelSubmit = deps.schedule(session.submitDelayMs, () => {
      delete session.cancelSubmit;
      if (sessions.get(terminalId) !== session || !deps.isAlive(terminalId)) {
        settleSubmit(session, "dropped");
        return;
      }
      if (!enter()) {
        settleSubmit(session, "dropped");
        finishDropped(terminalId, "write-failed", true);
      }
    });
    return true;
  };

  const verifyAfterEnter = (
    terminalId: string,
    session: Session,
    enterAt: number,
    retried: boolean,
    tag: string | undefined,
    text: string,
  ): void => {
    const lastOutputAt = deps.lastOutputAt;
    if (!session.verifySubmit || (lastOutputAt === undefined && !session.turnStartSource)) {
      settleSubmit(session, "unverified");
      return;
    }
    session.cancelSubmit = deps.schedule(submitVerifyMs, () => {
      delete session.cancelSubmit;
      if (sessions.get(terminalId) !== session || !deps.isAlive(terminalId)) {
        settleSubmit(session, "dropped");
        return;
      }
      if (session.phase !== "busy") {
        // 已经回合结束或在等批准：都说明提交了。
        settleSubmit(session, "submitted");
        return;
      }
      if (session.turnStartSource) {
        // 有真信号就只认真信号：回车之后有没有开始一轮。
        if (session.lastTurnStartAt >= enterAt) {
          settleSubmit(session, "submitted");
          return;
        }
      } else {
        const last = lastOutputAt?.(terminalId) ?? 0;
        if (last >= enterAt + SUBMIT_ECHO_GRACE_MS) {
          settleSubmit(session, "submitted");
          return;
        }
      }
      const retryOrFail = (holds: boolean | undefined): void => {
        retryOrReport(terminalId, session, retried, tag, text, holds);
      };
      const look = deps.inputStillHolds;
      if (look === undefined) {
        retryOrFail(undefined);
        return;
      }
      // 看屏幕期间占住核对位：这时又来一条，按顶掉处理，不再重打这一条。
      let superseded = false;
      session.cancelSubmit = () => {
        superseded = true;
      };
      const after = (holds: boolean | undefined): void => {
        if (superseded || sessions.get(terminalId) !== session) {
          return;
        }
        delete session.cancelSubmit;
        if (holds === false) {
          // 输入框已经空了：其实提交了，只是信号没赶上。
          settleSubmit(session, "submitted");
          return;
        }
        retryOrFail(holds);
      };
      look(terminalId, text).then(after, () => after(undefined));
    });
  };

  /**
   * 确认没提交：第一次清掉重打（或补回车），第二次清掉后报 not-submitted。
   * 只有屏幕上看得到这段文字还在输入框里（holds 为 true）才清掉重打；看不出来就只补回车，
   * 免得把其实已经提交的再发一遍（空输入框上补回车不会发出东西）。
   */
  const retryOrReport = (
    terminalId: string,
    session: Session,
    retried: boolean,
    tag: string | undefined,
    text: string,
    holds: boolean | undefined,
  ): void => {
    const visible = holds === true && session.clearInput !== undefined;
    if (!retried) {
      if (visible && session.clearInput !== undefined) {
        // 回车被吃成了换行：清掉输入框重打一遍，不在原来那段后面接着按。
        try {
          deps.write(terminalId, session.clearInput);
        } catch {
          settleSubmit(session, "dropped");
          return;
        }
        if (!typeAndEnter(terminalId, session, text, true, tag)) {
          settleSubmit(session, "dropped");
        }
        return;
      }
      try {
        deps.write(terminalId, "\r");
      } catch {
        settleSubmit(session, "dropped");
        return;
      }
      verifyAfterEnter(terminalId, session, deps.now(), true, tag, text);
      return;
    }
    if (visible && session.clearInput !== undefined) {
      // 不留在输入框里：下一条提醒不会接在后面堆起来。
      try {
        deps.write(terminalId, session.clearInput);
      } catch {
        // 终端已经写不进去，下面照常报没提交。
      }
    }
    session.phase = "unknown";
    settleSubmit(session, "not-submitted");
    deps.onDeferred?.({
      terminalId,
      status: "dropped",
      reason: "not-submitted",
      ...(tag !== undefined ? { tag } : {}),
    });
    notifyPending(terminalId);
  };

  const writeItem = (terminalId: string, session: Session, item: QueuedItem): boolean => {
    const tag = item.tag ?? session.windowId;
    // 上一条还在核对就被顶掉：它的回车已经写出，按不核对算。
    clearSubmit(session, "unverified");
    session.hadTurn = true;
    if (item.onSubmit !== undefined) {
      session.submitWaiter = item.onSubmit;
    }
    return typeAndEnter(terminalId, session, item.text, false, tag);
  };

  const deliverHead = (terminalId: string, notify: boolean): boolean => {
    const session = sessions.get(terminalId);
    const item = session?.queue[0];
    if (session === undefined || item === undefined) {
      return false;
    }
    if (!writeItem(terminalId, session, item)) {
      if (session.submitWaiter === item.onSubmit) {
        delete session.submitWaiter;
      }
      finishDropped(terminalId, "write-failed", notify);
      item.onSubmit?.("dropped");
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
    if (!canAuto(terminalId, session, item)) {
      arm(terminalId);
      notifyPending(terminalId);
      return {
        status: "queued",
        mode:
          session.phase === "unknown" && item.allowUnknown === true
            ? "auto"
            : holdMode(session.phase),
      };
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
      if (options?.submitDelayMs !== undefined && Number.isFinite(options.submitDelayMs)) {
        session.submitDelayMs = Math.max(0, Math.floor(options.submitDelayMs));
      }
      if (options?.verifySubmit !== undefined) {
        session.verifySubmit = options.verifySubmit;
      }
      if (options?.turnStartSource !== undefined) {
        session.turnStartSource = options.turnStartSource;
      }
      if (options?.bracketedPaste !== undefined) {
        session.bracketedPaste = options.bracketedPaste;
      }
      if (options?.clearInput !== undefined && options.clearInput !== "") {
        session.clearInput = options.clearInput;
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
        session.hadTurn = true;
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
        session.hadTurn = true;
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
      session.hadTurn = true;
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
      // 同样的一句还排着（比如反复叫醒）：不再排第二份，免得送到时一连打好几遍。
      if (session.queue.some((queued) => queued.text === input.text)) {
        input.onSubmit?.("dropped");
        return { status: "queued", mode: holdMode(session.phase) };
      }
      const item: QueuedItem = {
        text: input.text,
        quietMs: input.quietMs ?? outputQuietDefault,
        ...(input.tag !== undefined ? { tag: input.tag } : {}),
        ...(input.inboxCount !== undefined ? { inboxCount: input.inboxCount } : {}),
        ...(input.allowUnknown === true ? { allowUnknown: true } : {}),
        ...(input.onSubmit !== undefined ? { onSubmit: input.onSubmit } : {}),
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
    enqueueInbox(terminalId, textForCount, onSubmit) {
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
      return this.enqueue({
        terminalId,
        text,
        inboxCount: nextCount,
        ...(onSubmit !== undefined ? { onSubmit } : {}),
      });
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
      const session = sessions.get(terminalId);
      if (session !== undefined) {
        clearSubmit(session, "dropped");
      }
      finishDropped(terminalId, "exited", true);
      sessions.delete(terminalId);
    },
    setTurnStartSource(terminalId, available) {
      ensure(terminalId).turnStartSource = available;
    },
    noteTurnStarted(terminalId) {
      const session = ensure(terminalId);
      session.lastTurnStartAt = deps.now();
      session.hadTurn = true;
      if (session.phase !== "blocked") {
        session.phase = "busy";
      }
    },
    notePromptReady(terminalId, options) {
      const session = sessions.get(terminalId);
      if (session === undefined || permissionOutstanding(session) > 0) {
        return false;
      }
      // 回车已写出、还在核对：等核对说了算。
      if (session.cancelSubmit !== undefined) {
        return false;
      }
      const settled = options?.settled === true;
      if (session.phase === "unknown") {
        if (session.initialPromptPending && !settled) {
          return false;
        }
      } else if (session.phase !== "busy" || !settled) {
        return false;
      }
      session.initialPromptPending = false;
      session.phase = "idle";
      if (session.queue.length > 0) {
        pump(terminalId, true);
      } else {
        notifyPending(terminalId);
      }
      return true;
    },
    hadTurn(terminalId) {
      return sessions.get(terminalId)?.hadTurn === true;
    },
    setPaused(terminalId, paused) {
      const session = sessions.get(terminalId);
      if (session === undefined) {
        return;
      }
      session.paused = paused;
      if (!paused && session.queue.length > 0) {
        pump(terminalId, true);
      }
    },
    dropInbox(terminalId) {
      const session = sessions.get(terminalId);
      if (session === undefined) {
        return 0;
      }
      const before = session.queue.length;
      session.queue = session.queue.filter((item) => item.inboxCount === undefined);
      const removed = before - session.queue.length;
      if (removed > 0) {
        if (session.queue.length === 0) {
          cancelTimer(terminalId);
        }
        notifyPending(terminalId);
      }
      return removed;
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
