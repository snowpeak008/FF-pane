/**
 * API 错误记录与「可以叫醒」的后续提醒。
 */

import { describe, expect, it } from "vitest";
import {
  API_ERROR_SAME_TURN_MS,
  createApiErrorTracker,
  RETRY_NUDGE_AFTER_MS,
} from "../src/main/workbench/api-error-tracker";

function harness() {
  let now = 1_000_000;
  const alive = new Set(["w"]);
  const notices: { at: number; windowId: string; text: string }[] = [];
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const tracker = createApiErrorTracker({
    now: () => now,
    schedule: (delay, fn) => {
      const timer = { at: now + delay, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    isAlive: (id) => alive.has(id),
    notify: (windowId, text) => {
      notices.push({ at: now, windowId, text });
    },
  });
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const next = timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (next === undefined) {
        break;
      }
      now = next.at;
      next.cancelled = true;
      next.fn();
    }
    now = target;
  };
  return { tracker, notices, advance, alive };
}

describe("API 错误记录", () => {
  it("限流：马上报一次，之后第 1、3、10 分钟提示可以叫醒", () => {
    const h = harness();
    h.tracker.note("w", "rate_limit");
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.text).toContain("账号限流（429）");
    h.advance(RETRY_NUDGE_AFTER_MS[2]);
    expect(h.notices.map((n) => n.text.includes("可以叫醒了"))).toEqual([false, true, true, true]);
    expect(h.notices[1]?.text).toContain("1 分钟");
    expect(h.notices[3]?.text).toContain("10 分钟");
  });

  it("同一轮的重复信号只算一次，且不让后续提醒失效（回归）", () => {
    const h = harness();
    h.tracker.note("w", "rate_limit");
    h.advance(500);
    h.tracker.note("w", "rate_limit");
    expect(h.notices).toHaveLength(1);
    h.advance(RETRY_NUDGE_AFTER_MS[0]);
    expect(h.notices.filter((n) => n.text.includes("可以叫醒了"))).toHaveLength(1);
  });

  it("被叫醒又开始干活：不再提示；又被限流是新的一次，照常报", () => {
    const h = harness();
    h.tracker.note("w", "rate_limit");
    h.advance(RETRY_NUDGE_AFTER_MS[0]);
    expect(h.notices).toHaveLength(2);
    h.tracker.turnStarted("w");
    h.advance(RETRY_NUDGE_AFTER_MS[2]);
    expect(h.notices).toHaveLength(2);
    h.tracker.note("w", "rate_limit");
    expect(h.notices).toHaveLength(3);
    expect(h.notices[2]?.text).toContain("中断");
  });

  it("认证这类错误只报一次，交给用户，不提示叫醒", () => {
    const h = harness();
    h.tracker.note("w", "authentication_failed");
    h.advance(RETRY_NUDGE_AFTER_MS[2]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.text).toContain("要用户处理");
  });

  it("正常结束紧跟在出错之后不清记录；隔久了的正常结束才清", () => {
    const h = harness();
    h.tracker.note("w", "rate_limit");
    h.advance(API_ERROR_SAME_TURN_MS - 1);
    expect(h.tracker.turnCompleted("w")).toBe(false);
    expect(h.tracker.get("w")?.type).toBe("rate_limit");
    h.advance(RETRY_NUDGE_AFTER_MS[0]);
    expect(h.tracker.turnCompleted("w")).toBe(true);
    expect(h.tracker.get("w")).toBeUndefined();
    h.advance(RETRY_NUDGE_AFTER_MS[2]);
    expect(h.notices.filter((n) => n.text.includes("可以叫醒了"))).toHaveLength(1);
  });

  it("窗口退出后不再提示；刚因可重试错误停下的算叫不醒别人", () => {
    const h = harness();
    h.tracker.note("w", "overloaded");
    expect(h.tracker.isRecentlyStalled("w", 60_000)).toBe(true);
    h.alive.delete("w");
    h.advance(RETRY_NUDGE_AFTER_MS[2]);
    expect(h.notices).toHaveLength(1);
    expect(h.tracker.isRecentlyStalled("w", 60_000)).toBe(false);
    h.tracker.note("x", "billing_error");
    expect(h.tracker.isRecentlyStalled("x", 60_000)).toBe(false);
  });
});
