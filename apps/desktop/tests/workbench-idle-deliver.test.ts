/**
 * T10.6'：空闲投递状态机。没有超时强写。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createIdleDeliverQueue,
  type IdleDeliverOutcome,
} from "../src/main/workbench/idle-deliver";

interface Harness {
  readonly writes: string[];
  readonly deferred: IdleDeliverOutcome[];
  readonly queue: ReturnType<typeof createIdleDeliverQueue>;
  advance(ms: number): void;
  setAlive(value: boolean): void;
  markBusy(): void;
}

function harness(): Harness {
  let now = 0;
  let alive = true;
  let lastOutput = -10_000;
  const writes: string[] = [];
  const deferred: IdleDeliverOutcome[] = [];
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const queue = createIdleDeliverQueue({
    isIdle: (_id, quietMs) => now - lastOutput >= quietMs,
    isAlive: () => alive,
    write: (_id, data) => {
      writes.push(data);
      lastOutput = now;
    },
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
    writes,
    deferred,
    queue,
    setAlive(value) {
      alive = value;
    },
    markBusy() {
      lastOutput = now;
    },
    advance(ms) {
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

describe("createIdleDeliverQueue", () => {
  it("Stop 且输出已静默、用户没在打字时写入正文再单独回车", () => {
    const h = harness();
    h.queue.attach("t1");
    h.queue.noteHook("t1", "stop");
    expect(h.queue.phaseOf("t1")).toBe("idle");
    const result = h.queue.enqueue({ terminalId: "t1", text: "hello" });
    expect(result).toEqual({ status: "delivered" });
    expect(h.writes).toEqual(["hello", "\r"]);
  });

  it("PermissionRequest 期间不投递，立即发送也被拒绝", () => {
    const h = harness();
    h.queue.attach("t1");
    h.queue.noteHook("t1", "stop");
    h.queue.noteHook("t1", "permission-request");
    const queued = h.queue.enqueue({ terminalId: "t1", text: "role" });
    expect(queued).toEqual({ status: "queued", mode: "blocked" });
    h.advance(60_000);
    expect(h.writes).toEqual([]);
    expect(h.queue.deliverNow("t1")).toEqual({ status: "refused", reason: "blocked" });
    expect(h.writes).toEqual([]);
  });

  it("用户刚输入时即使 Stop 也要等输入静默", () => {
    const h = harness();
    h.queue.attach("t1");
    h.queue.noteHook("t1", "stop");
    h.queue.noteInput("t1", 0);
    h.markBusy();
    const queued = h.queue.enqueue({ terminalId: "t1", text: "hello" });
    expect(queued).toEqual({ status: "queued", mode: "auto" });
    h.advance(900);
    expect(h.writes).toEqual([]);
    h.advance(200);
    expect(h.writes).toEqual(["hello", "\r"]);
  });

  it("没有 hook 时只手动发送，不猜空闲", () => {
    const h = harness();
    h.queue.attach("t1");
    expect(h.queue.phaseOf("t1")).toBe("unknown");
    const queued = h.queue.enqueue({ terminalId: "t1", text: "hello", tag: "win" });
    expect(queued).toEqual({ status: "queued", mode: "manual" });
    h.advance(60_000);
    expect(h.writes).toEqual([]);
    expect(h.queue.deliverNow("t1")).toEqual({ status: "delivered", count: 1 });
    expect(h.writes).toEqual(["hello", "\r"]);
    expect(h.queue.phaseOf("t1")).toBe("busy");
  });

  it("提交回车后立刻变忙，回合结束才恢复空闲并投递", () => {
    const h = harness();
    h.queue.attach("t1");
    h.queue.noteHook("t1", "stop");
    expect(h.queue.phaseOf("t1")).toBe("idle");
    h.queue.noteSubmit("t1");
    expect(h.queue.phaseOf("t1")).toBe("busy");
    expect(h.queue.enqueue({ terminalId: "t1", text: "hello" })).toEqual({
      status: "queued",
      mode: "busy",
    });
    h.advance(60_000);
    expect(h.writes).toEqual([]);
    expect(h.queue.deliverNow("t1")).toEqual({ status: "refused", reason: "busy" });
    h.queue.noteHook("t1", "stop");
    expect(h.queue.phaseOf("t1")).toBe("busy");
    expect(h.writes).toEqual(["hello", "\r"]);
  });

  it("未知时提交回车后不再允许手动发送，要等回合结束", () => {
    const h = harness();
    h.queue.attach("t1");
    h.queue.enqueue({ terminalId: "t1", text: "hello" });
    h.queue.noteSubmit("t1");
    expect(h.queue.phaseOf("t1")).toBe("busy");
    h.advance(60_000);
    expect(h.writes).toEqual([]);
    expect(h.queue.deliverNow("t1")).toEqual({ status: "refused", reason: "busy" });
    h.queue.noteHook("t1", "stop");
    expect(h.writes).toEqual(["hello", "\r"]);
  });

  it("权限阻塞时提交回车仍保持阻塞", () => {
    const h = harness();
    h.queue.attach("t1");
    h.queue.noteHook("t1", "stop");
    h.queue.noteHook("t1", "permission-request");
    h.queue.noteSubmit("t1");
    expect(h.queue.phaseOf("t1")).toBe("blocked");
    h.queue.enqueue({ terminalId: "t1", text: "hello" });
    h.advance(60_000);
    expect(h.writes).toEqual([]);
    expect(h.queue.deliverNow("t1")).toEqual({ status: "refused", reason: "blocked" });
  });

  it("没有 initialPrompt 时 SessionStart 视为在等输入；有 initialPrompt 则仍未知", () => {
    const waiting = harness();
    waiting.queue.attach("t1");
    waiting.queue.noteHook("t1", "session-start");
    expect(waiting.queue.phaseOf("t1")).toBe("idle");

    const prompted = harness();
    prompted.queue.attach("t1", { initialPrompt: true });
    prompted.queue.noteHook("t1", "session-start");
    expect(prompted.queue.phaseOf("t1")).toBe("unknown");
    prompted.queue.enqueue({ terminalId: "t1", text: "x" });
    prompted.advance(5_000);
    expect(prompted.writes).toEqual([]);
  });

  it("多条按序，用户提交期间不写，Stop 之后才写", () => {
    const h = harness();
    h.queue.attach("t1");
    h.queue.noteHook("t1", "user-prompt-submit");
    expect(h.queue.enqueue({ terminalId: "t1", text: "one" })).toEqual({
      status: "queued",
      mode: "busy",
    });
    expect(h.queue.enqueue({ terminalId: "t1", text: "two" })).toEqual({
      status: "queued",
      mode: "busy",
    });
    expect(h.queue.deliverNow("t1")).toEqual({ status: "refused", reason: "busy" });
    h.advance(60_000);
    expect(h.writes).toEqual([]);
    h.queue.noteHook("t1", "stop");
    expect(h.writes).toEqual(["one", "\r"]);
    expect(h.queue.phaseOf("t1")).toBe("busy");
    h.advance(60_000);
    expect(h.writes).toEqual(["one", "\r"]);
    h.queue.noteHook("t1", "stop");
    expect(h.writes).toEqual(["one", "\r", "two", "\r"]);
  });

  it("窗口退出清空队列，之后不再写入", () => {
    const h = harness();
    h.queue.attach("t1");
    h.queue.enqueue({ terminalId: "t1", text: "hello", tag: "win" });
    h.queue.drop("t1");
    expect(h.queue.pendingCount("t1")).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.deferred[0]).toMatchObject({ status: "dropped", reason: "exited", tag: "win" });
    h.setAlive(false);
    expect(h.queue.enqueue({ terminalId: "t1", text: "later" })).toEqual({
      status: "dropped",
      reason: "exited",
    });
    expect(h.writes).toEqual([]);
  });

  it("源码没有超时强写路径", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/main/workbench/idle-deliver.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/forced/i);
    expect(source).not.toMatch(/timeout/i);
  });
});
