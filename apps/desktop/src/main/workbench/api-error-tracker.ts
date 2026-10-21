/**
 * 窗口因 API 错误停下的记录和后续处理（用户 2026-10-22 定的规则）。
 *
 * - 限流这一类（429、额度、计费、认证、模型不存在……）：开发暂停，等用户的指令。
 *   不倒计时、不提醒「可以叫醒」，监管者也不能叫醒它；窗口保留，之后可以续接。
 * - 网络或服务端的临时故障（服务端出错、过载、说不清的）：不用谁思考，平台隔一会儿自己让它接着做。
 *   连着失败 3 次就不再自己接着做，按暂停处理。
 * - 一轮因错误结束（Claude 的 StopFailure、Codex rollout 里带 error 的 task_complete）时记下类型和时间，
 *   告诉监管者或上级。同一轮的重复信号（notify 和 rollout 各报一次）只算一次，也不改原来的时间。
 * - 又开始一轮（用户接手或被叫醒）就不算暂停；一轮正常结束就清掉记录。
 */

export const API_ERROR_TEXT: Readonly<Record<string, string>> = {
  rate_limit: "账号限流（429）",
  overloaded: "服务过载",
  authentication_failed: "认证失败",
  oauth_org_not_allowed: "组织不允许",
  account_on_hold: "账号被暂停",
  billing_error: "计费问题",
  invalid_request: "请求无效",
  model_not_found: "找不到模型",
  server_error: "服务端错误",
  max_output_tokens: "输出超长",
  cloud_credential_error: "云凭据错误",
};

/** 网络或服务端的临时故障：平台自己让它接着做。其余一律暂停等用户。 */
export const TRANSIENT_API_ERRORS: ReadonlySet<string> = new Set([
  "overloaded",
  "server_error",
  "unknown",
]);

/** 临时故障后隔多久让它接着做。 */
export const TRANSIENT_RETRY_AFTER_MS = 30_000;
/** 临时故障连着这么多次就不再自己接着做。 */
export const TRANSIENT_RETRY_MAX = 3;
/** 两个信号相隔这么近，算同一轮。 */
export const API_ERROR_SAME_TURN_MS = 3_000;

export function apiErrorLabel(type: string): string {
  return API_ERROR_TEXT[type] ?? `API 错误（${type}）`;
}

export interface ApiErrorRecord {
  readonly type: string;
  readonly label: string;
  readonly at: number;
  /** 开发暂停，等用户的指令（限流这一类，或临时故障连着失败太多次）。 */
  readonly paused: boolean;
}

export interface ApiErrorTracker {
  /** 一轮因 API 错误结束。 */
  note(windowId: string, type: string): void;
  get(windowId: string): ApiErrorRecord | undefined;
  /** 因错误停下、在等用户的指令（又开始一轮之后就不算）。 */
  isPaused(windowId: string): boolean;
  /** 最近 withinMs 内因错误停下、还没又开始一轮。 */
  isRecentlyStalled(windowId: string, withinMs: number): boolean;
  /** 又开始一轮了（被叫醒或用户接手）：不再算暂停，记录留到这一轮正常结束。 */
  turnStarted(windowId: string): void;
  /** 一轮正常结束。紧跟在出错之后的（同一轮的另一个信号）不算，返回 false。 */
  turnCompleted(windowId: string): boolean;
  /** 窗口退出。 */
  forget(windowId: string): void;
  dispose(): void;
}

interface Record_ {
  type: string;
  at: number;
  paused: boolean;
  resumed: boolean;
}

export function createApiErrorTracker(deps: {
  readonly now: () => number;
  readonly schedule: (delayMs: number, fn: () => void) => () => void;
  readonly isAlive: (windowId: string) => boolean;
  readonly notify: (windowId: string, text: string) => void;
  /** 临时故障：平台让它接着做（只发固定的「继续」）。 */
  readonly autoContinue?: (windowId: string, label: string) => void;
}): ApiErrorTracker {
  const records = new Map<string, Record_>();
  /** 每个窗口连着几次临时故障。一轮正常结束清零。 */
  const transientStreak = new Map<string, number>();
  const pending = new Map<string, () => void>();

  const cancelFollowUp = (windowId: string): void => {
    pending.get(windowId)?.();
    pending.delete(windowId);
  };

  return {
    note(windowId, type) {
      const now = deps.now();
      const previous = records.get(windowId);
      if (previous?.type === type && now - previous.at < API_ERROR_SAME_TURN_MS) {
        return;
      }
      cancelFollowUp(windowId);
      const label = apiErrorLabel(type);
      const transient = TRANSIENT_API_ERRORS.has(type);
      const streak = transient ? (transientStreak.get(windowId) ?? 0) + 1 : 0;
      if (transient) {
        transientStreak.set(windowId, streak);
      }
      const paused = !transient || streak > TRANSIENT_RETRY_MAX || deps.autoContinue === undefined;
      records.set(windowId, { type, at: now, paused, resumed: false });
      if (paused) {
        deps.notify(
          windowId,
          transient
            ? `连着 ${streak} 次因${label}中断，平台不再自动让它接着做。开发暂停，等用户的指令；它的窗口和锁都保留，之后可以续接。不要叫醒它。`
            : `这一轮因${label}停下。开发暂停，等用户的指令；它的窗口和锁都保留，之后可以续接。不要叫醒它。`,
        );
        return;
      }
      if (streak === 1) {
        deps.notify(
          windowId,
          `这一轮因${label}中断（网络或服务端的临时故障），平台会在 ${Math.round(TRANSIENT_RETRY_AFTER_MS / 1000)} 秒后自己让它接着做，不用处理。`,
        );
      }
      pending.set(
        windowId,
        deps.schedule(TRANSIENT_RETRY_AFTER_MS, () => {
          pending.delete(windowId);
          const still = records.get(windowId);
          if (still === undefined || still.at !== now || still.resumed || !deps.isAlive(windowId)) {
            return;
          }
          deps.autoContinue?.(windowId, label);
        }),
      );
    },
    get(windowId) {
      const record = records.get(windowId);
      return record === undefined
        ? undefined
        : {
            type: record.type,
            label: apiErrorLabel(record.type),
            at: record.at,
            paused: record.paused && !record.resumed,
          };
    },
    isPaused(windowId) {
      const record = records.get(windowId);
      return record?.paused === true && !record.resumed;
    },
    isRecentlyStalled(windowId, withinMs) {
      const record = records.get(windowId);
      return record !== undefined && !record.resumed && deps.now() - record.at < withinMs;
    },
    turnStarted(windowId) {
      cancelFollowUp(windowId);
      const record = records.get(windowId);
      if (record !== undefined) {
        record.resumed = true;
      }
    },
    turnCompleted(windowId) {
      const record = records.get(windowId);
      if (record !== undefined && deps.now() - record.at < API_ERROR_SAME_TURN_MS) {
        return false;
      }
      records.delete(windowId);
      transientStreak.delete(windowId);
      cancelFollowUp(windowId);
      return true;
    },
    forget(windowId) {
      records.delete(windowId);
      transientStreak.delete(windowId);
      cancelFollowUp(windowId);
    },
    dispose() {
      for (const windowId of [...pending.keys()]) {
        cancelFollowUp(windowId);
      }
      records.clear();
      transientStreak.clear();
    },
  };
}
