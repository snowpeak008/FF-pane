/**
 * 投递提交核对：Codex 回车延迟、没提交时补回车再报错，以及读空收件箱撤掉提醒。
 */

import { describe, expect, it } from "vitest";
import {
  CODEX_SUBMIT_DELAY_MS,
  createIdleDeliverQueue,
  DEFAULT_SUBMIT_VERIFY_MS,
  type IdleDeliverOutcome,
} from "../src/main/workbench/idle-deliver";

function harness() {
  let now = 0;
  let lastOutput = -10_000;
  const writes: { at: number; data: string }[] = [];
  const deferred: IdleDeliverOutcome[] = [];
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const queue = createIdleDeliverQueue({
    isIdle: (_id, quietMs) => now - lastOutput >= quietMs,
    isAlive: () => true,
    write: (_id, data) => {
      writes.push({ at: now, data });
      lastOutput = now;
    },
    lastOutputAt: () => lastOutput,
    now: () => now,
    schedule: (delayMs, fn) => {
      const timer = { at: now + delayMs, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    onDeferred: (outcome) => {
      deferred.push(outcome);
    },
    outputQuietMs: 1000,
    inputQuietMs: 1000,
    pollMs: 200,
  });
  return {
    queue,
    writes,
    deferred,
    output() {
      lastOutput = now;
    },
    advance(ms: number) {
      const target = now + ms;
      while (now < target) {
        const next = timers
          .filter((timer) => !timer.cancelled && timer.at > now && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (next === undefined) {
          now = target;
          return;
        }
        now = next.at;
        next.cancelled = true;
        next.fn();
      }
    },
  };
}

function idleCodex(h: ReturnType<typeof harness>): void {
  h.queue.attach("t1", {
    windowId: "w1",
    submitDelayMs: CODEX_SUBMIT_DELAY_MS,
    verifySubmit: true,
  });
  h.queue.noteHook("t1", "stop");
  h.advance(2000);
}

describe("提交核对", () => {
  it("Codex：正文写完隔一会儿才写回车", () => {
    const h = harness();
    idleCodex(h);
    expect(h.queue.enqueue({ terminalId: "t1", text: "[新消息] 你好" })).toEqual({
      status: "delivered",
    });
    expect(h.writes.map((w) => w.data)).toEqual(["[新消息] 你好"]);
    h.advance(CODEX_SUBMIT_DELAY_MS);
    expect(h.writes.map((w) => w.data)).toEqual(["[新消息] 你好", "\r"]);
    expect((h.writes[1]?.at ?? 0) - (h.writes[0]?.at ?? 0)).toBe(CODEX_SUBMIT_DELAY_MS);
  });

  it("回车后一直有开工输出就不补回车", () => {
    const h = harness();
    idleCodex(h);
    h.queue.enqueue({ terminalId: "t1", text: "活" });
    h.advance(CODEX_SUBMIT_DELAY_MS + 2000);
    h.output();
    h.advance(DEFAULT_SUBMIT_VERIFY_MS * 3);
    expect(h.writes.filter((w) => w.data === "\r")).toHaveLength(1);
    expect(h.deferred).toEqual([]);
  });

  it("回车后终端没动静：补一次回车；还不动就报 not-submitted 并转手动", () => {
    const h = harness();
    idleCodex(h);
    h.queue.enqueue({ terminalId: "t1", text: "卡住" });
    h.advance(CODEX_SUBMIT_DELAY_MS + DEFAULT_SUBMIT_VERIFY_MS);
    expect(h.writes.filter((w) => w.data === "\r")).toHaveLength(2);
    expect(h.deferred).toEqual([]);
    h.advance(DEFAULT_SUBMIT_VERIFY_MS);
    expect(h.writes.filter((w) => w.data === "\r")).toHaveLength(2);
    expect(h.deferred).toEqual([
      { terminalId: "t1", status: "dropped", reason: "not-submitted", tag: "w1" },
    ]);
    expect(h.queue.phaseOf("t1")).toBe("unknown");
  });

  it("回合信号先到（已经做完）就不再核对", () => {
    const h = harness();
    idleCodex(h);
    h.queue.enqueue({ terminalId: "t1", text: "快" });
    h.advance(CODEX_SUBMIT_DELAY_MS + 500);
    h.queue.noteHook("t1", "stop");
    h.advance(DEFAULT_SUBMIT_VERIFY_MS * 2);
    expect(h.writes.filter((w) => w.data === "\r")).toHaveLength(1);
    expect(h.deferred).toEqual([]);
  });

  it("没开核对的终端行为不变：正文和回车紧接着写", () => {
    const h = harness();
    h.queue.attach("t2", { windowId: "w2" });
    h.queue.noteHook("t2", "stop");
    h.advance(2000);
    h.queue.enqueue({ terminalId: "t2", text: "旧" });
    expect(h.writes.map((w) => w.data)).toEqual(["旧", "\r"]);
    h.advance(DEFAULT_SUBMIT_VERIFY_MS * 3);
    expect(h.writes).toHaveLength(2);
  });

  it("读空收件箱后撤掉排队的提醒，其它排队项不动", () => {
    const h = harness();
    h.queue.attach("t3", { windowId: "w3" });
    h.queue.noteHook("t3", "user-prompt-submit");
    h.queue.enqueue({ terminalId: "t3", text: "角色切换" });
    h.queue.enqueueInbox("t3", (n) => `[新消息] ${n}`);
    h.queue.enqueueInbox("t3", (n) => `[新消息] ${n}`);
    expect(h.queue.pendingCount("t3")).toBe(2);
    expect(h.queue.dropInbox("t3")).toBe(1);
    expect(h.queue.pendingCount("t3")).toBe(1);
    h.queue.noteHook("t3", "stop");
    h.advance(2000);
    expect(h.writes.map((w) => w.data)).toEqual(["角色切换", "\r"]);
  });
});
