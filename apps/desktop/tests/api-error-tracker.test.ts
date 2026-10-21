/**
 * API 错误记录（2026-10-22 规则）：限流这一类暂停等用户的指令，不倒计时；
 * 网络或服务端的临时故障由平台自己让它接着做，连着 3 次以后按暂停处理。
 */

import { describe, expect, it } from "vitest";
import {
  API_ERROR_SAME_TURN_MS,
  createApiErrorTracker,
  TRANSIENT_RETRY_AFTER_MS,
  TRANSIENT_RETRY_MAX,
} from "../src/main/workbench/api-error-tracker";

function harness() {
  let now = 1_000_000;
  const alive = new Set(["w"]);
  const notices: { at: number; windowId: string; text: string }[] = [];
  const continued: { at: number; windowId: string; label: string }[] = [];
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
    autoContinue: (windowId, label) => {
      continued.push({ at: now, windowId, label });
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
  return { tracker, notices, continued, advance, alive };
}

describe("API 错误记录", () => {
  it("限流：报一次「开发暂停，等用户的指令」，之后不倒计时、不自动接着做", () => {
    const h = harness();
    h.tracker.note("w", "rate_limit");
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.text).toContain("账号限流（429）");
    expect(h.notices[0]?.text).toContain("等用户的指令");
    expect(h.tracker.isPaused("w")).toBe(true);
    h.advance(60 * 60_000);
    expect(h.notices).toHaveLength(1);
    expect(h.continued).toEqual([]);
  });

  it("用户叫醒（又开始一轮）后不算暂停；正常结束清掉记录", () => {
    const h = harness();
    h.tracker.note("w", "rate_limit");
    h.tracker.turnStarted("w");
    expect(h.tracker.isPaused("w")).toBe(false);
    h.advance(API_ERROR_SAME_TURN_MS + 1);
    expect(h.tracker.turnCompleted("w")).toBe(true);
    expect(h.tracker.get("w")).toBeUndefined();
  });

  it("临时故障：报一次，30 秒后平台自己让它接着做，不算暂停", () => {
    const h = harness();
    h.tracker.note("w", "server_error");
    expect(h.tracker.isPaused("w")).toBe(false);
    expect(h.notices[0]?.text).toContain("临时故障");
    h.advance(TRANSIENT_RETRY_AFTER_MS);
    expect(h.continued).toEqual([
      { at: 1_000_000 + TRANSIENT_RETRY_AFTER_MS, windowId: "w", label: "服务端错误" },
    ]);
  });

  it("临时故障连着超过 3 次：不再自己接着做，按暂停处理", () => {
    const h = harness();
    for (let round = 0; round < TRANSIENT_RETRY_MAX; round += 1) {
      h.tracker.note("w", "overloaded");
      h.advance(TRANSIENT_RETRY_AFTER_MS);
      h.tracker.turnStarted("w");
      h.advance(API_ERROR_SAME_TURN_MS + 1);
    }
    expect(h.continued).toHaveLength(TRANSIENT_RETRY_MAX);
    h.tracker.note("w", "overloaded");
    expect(h.tracker.isPaused("w")).toBe(true);
    expect(h.notices.at(-1)?.text).toContain("不再自动让它接着做");
    h.advance(TRANSIENT_RETRY_AFTER_MS);
    expect(h.continued).toHaveLength(TRANSIENT_RETRY_MAX);
  });

  it("一轮正常结束后，临时故障的次数重新算", () => {
    const h = harness();
    h.tracker.note("w", "overloaded");
    h.advance(TRANSIENT_RETRY_AFTER_MS + API_ERROR_SAME_TURN_MS + 1);
    expect(h.tracker.turnCompleted("w")).toBe(true);
    h.tracker.note("w", "overloaded");
    // 又是第一次：会报「临时故障」并安排接着做。
    expect(h.notices.at(-1)?.text).toContain("临时故障");
    expect(h.tracker.isPaused("w")).toBe(false);
  });

  it("等的时候窗口又开始干活或已经退出：不再自己接着做", () => {
    const h = harness();
    h.tracker.note("w", "server_error");
    h.tracker.turnStarted("w");
    h.advance(TRANSIENT_RETRY_AFTER_MS);
    expect(h.continued).toEqual([]);
    const g = harness();
    g.tracker.note("w", "server_error");
    g.alive.delete("w");
    g.advance(TRANSIENT_RETRY_AFTER_MS);
    expect(g.continued).toEqual([]);
  });

  it("同一轮的两个出错信号只算一次", () => {
    const h = harness();
    h.tracker.note("w", "rate_limit");
    h.advance(1000);
    h.tracker.note("w", "rate_limit");
    expect(h.notices).toHaveLength(1);
  });
});
