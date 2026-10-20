/**
 * 窗口因 API 错误停下的记录和后续提醒。
 *
 * - 一轮因错误结束（Claude 的 StopFailure、Codex rollout 里带 error 的 task_complete）时记下类型和时间，
 *   马上告诉监管者或上级。同一轮的重复信号（notify 和 rollout 各报一次）只算一次，也不改原来的时间。
 * - 等一会儿就可能好的错误（限流、过载、服务端出错、说不清的），停下后第 1、3、10 分钟再提醒「可以叫醒了」，
 *   由监管者用 ffpane_nudge 叫醒。窗口又开始干活、退出，或出了新的错误，旧的提醒就作废。
 * - 等也不会好的错误（认证、计费、模型不存在……）只报一次，交给用户处理。
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

export const RETRYABLE_API_ERRORS: ReadonlySet<string> = new Set([
  "rate_limit",
  "overloaded",
  "server_error",
  "unknown",
]);

/** 停下后隔多久提醒一次「可以叫醒了」。 */
export const RETRY_NUDGE_AFTER_MS = [60_000, 180_000, 600_000] as const;
/** 两个信号相隔这么近，算同一轮。 */
export const API_ERROR_SAME_TURN_MS = 3_000;

export function apiErrorLabel(type: string): string {
  return API_ERROR_TEXT[type] ?? `API 错误（${type}）`;
}

export interface ApiErrorRecord {
  readonly type: string;
  readonly label: string;
  readonly at: number;
}

export interface ApiErrorTracker {
  /** 一轮因 API 错误结束。 */
  note(windowId: string, type: string): void;
  get(windowId: string): ApiErrorRecord | undefined;
  /** 最近 withinMs 内因可重试的错误停下（多半同一账号被限流），叫不醒别人。 */
  isRecentlyStalled(windowId: string, withinMs: number): boolean;
  /** 又开始一轮了（被叫醒或用户接手）：不再提醒「可以叫醒」，记录留到这一轮正常结束。 */
  turnStarted(windowId: string): void;
  /** 一轮正常结束。紧跟在出错之后的（同一轮的另一个信号）不算，返回 false。 */
  turnCompleted(windowId: string): boolean;
  /** 窗口退出。 */
  forget(windowId: string): void;
  dispose(): void;
}

export function createApiErrorTracker(deps: {
  readonly now: () => number;
  readonly schedule: (delayMs: number, fn: () => void) => () => void;
  readonly isAlive: (windowId: string) => boolean;
  readonly notify: (windowId: string, text: string) => void;
}): ApiErrorTracker {
  const records = new Map<string, { type: string; at: number }>();
  const pending = new Map<string, (() => void)[]>();

  const cancelFollowUps = (windowId: string): void => {
    for (const cancel of pending.get(windowId) ?? []) {
      cancel();
    }
    pending.delete(windowId);
  };

  return {
    note(windowId, type) {
      const now = deps.now();
      const previous = records.get(windowId);
      if (previous?.type === type && now - previous.at < API_ERROR_SAME_TURN_MS) {
        return;
      }
      records.set(windowId, { type, at: now });
      cancelFollowUps(windowId);
      const label = apiErrorLabel(type);
      if (!RETRYABLE_API_ERRORS.has(type)) {
        deps.notify(
          windowId,
          `这一轮因${label}中断，已经停下，它持有的锁还在。这类错误等也不会好，要用户处理（例如重新登录、改配置），写进近况报给管理者。`,
        );
        return;
      }
      deps.notify(
        windowId,
        `这一轮因${label}中断，已经停下，它持有的锁还在。过一会儿平台会提示「可以叫醒」，到时用 ffpane_nudge 叫醒它。`,
      );
      pending.set(
        windowId,
        RETRY_NUDGE_AFTER_MS.map((delay) =>
          deps.schedule(delay, () => {
            const still = records.get(windowId);
            if (still === undefined || still.at !== now || !deps.isAlive(windowId)) {
              return;
            }
            deps.notify(
              windowId,
              `因${label}停下已经 ${Math.round(delay / 60_000)} 分钟，可以叫醒了：用 ffpane_nudge 让它接着做。叫醒后还被限流，平台会再报。`,
            );
          }),
        ),
      );
    },
    get(windowId) {
      const record = records.get(windowId);
      return record === undefined ? undefined : { ...record, label: apiErrorLabel(record.type) };
    },
    isRecentlyStalled(windowId, withinMs) {
      const record = records.get(windowId);
      return (
        record !== undefined &&
        RETRYABLE_API_ERRORS.has(record.type) &&
        deps.now() - record.at < withinMs
      );
    },
    turnStarted(windowId) {
      cancelFollowUps(windowId);
    },
    turnCompleted(windowId) {
      const record = records.get(windowId);
      if (record !== undefined && deps.now() - record.at < API_ERROR_SAME_TURN_MS) {
        return false;
      }
      records.delete(windowId);
      cancelFollowUps(windowId);
      return true;
    },
    forget(windowId) {
      records.delete(windowId);
      cancelFollowUps(windowId);
    },
    dispose() {
      for (const windowId of [...pending.keys()]) {
        cancelFollowUps(windowId);
      }
      records.clear();
    },
  };
}
