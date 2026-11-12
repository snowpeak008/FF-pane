/**
 * 主线程看门狗的判断规则（T11.12）。纯函数，单测直接测。
 *
 * 只给看门狗工作线程（watchdog-worker.ts）用：工作线程单独打包成 .mjs，
 * 不能和主进程共用模块（共用就会拆出公共 chunk，解包后的 .mjs 引不到 asar 里的 chunk）。
 * 所以这里不 import 任何东西，阈值由主线程经 workerData 传进来。
 */

export interface WatchdogLimits {
  /** 平时主线程多久没心跳就记一行「冻住」，之后每隔这么久再记一行。 */
  readonly frozenLogMs: number;
  /** 关窗、退出过程中主线程多久没心跳就强退。 */
  readonly closingFrozenKillMs: number;
  /** 关窗、退出开始后，不管有没有心跳，最多等这么久。 */
  readonly closingMaxMs: number;
}

export interface WatchdogState {
  readonly lastBeat: number;
  /** 收到「开始关窗 / 退出」的时间；平时没有。 */
  readonly closingSince?: number;
  /** 上次记「冻住」的时间；恢复心跳后清掉。 */
  readonly frozenLoggedAt?: number;
}

export type WatchdogAction =
  | { readonly kind: "none" }
  | { readonly kind: "log-frozen"; readonly silentMs: number }
  | {
      readonly kind: "kill";
      readonly reason: "closing-frozen" | "closing-too-long";
      readonly silentMs: number;
    };

/** 每秒判断一次。关窗、退出时卡住就强退；平时卡住只记日志。 */
export function decideWatchdogTick(
  state: WatchdogState,
  now: number,
  limits: WatchdogLimits,
): { readonly action: WatchdogAction; readonly state: WatchdogState } {
  const silentMs = now - state.lastBeat;
  if (state.closingSince !== undefined) {
    if (silentMs >= limits.closingFrozenKillMs) {
      return { action: { kind: "kill", reason: "closing-frozen", silentMs }, state };
    }
    if (now - state.closingSince >= limits.closingMaxMs) {
      return { action: { kind: "kill", reason: "closing-too-long", silentMs }, state };
    }
  }
  if (
    silentMs >= limits.frozenLogMs &&
    (state.frozenLoggedAt === undefined || now - state.frozenLoggedAt >= limits.frozenLogMs)
  ) {
    return { action: { kind: "log-frozen", silentMs }, state: { ...state, frozenLoggedAt: now } };
  }
  return { action: { kind: "none" }, state };
}

/** 收到主线程心跳。之前记过「冻住」的，返回冻了多久，好记一行「恢复」。 */
export function noteBeat(
  state: WatchdogState,
  now: number,
): { readonly state: WatchdogState; readonly recoveredAfterMs?: number } {
  const next: WatchdogState =
    state.closingSince !== undefined
      ? { lastBeat: now, closingSince: state.closingSince }
      : { lastBeat: now };
  if (state.frozenLoggedAt !== undefined) {
    return { state: next, recoveredAfterMs: now - state.lastBeat };
  }
  return { state: next };
}

/** 收到「开始关窗 / 退出」。重复收到不重新计时。 */
export function noteClosing(state: WatchdogState, now: number): WatchdogState {
  return state.closingSince !== undefined ? state : { ...state, closingSince: now };
}

/** 和 policy.ts 的 logFileNameFor 一样（单测核对两边一致），看门狗直接往主进程日志里追加。 */
export function watchdogLogFileName(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `main-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.log`;
}
