/**
 * 在线监管：等待调用、在线期间的事件转交、下线、离线后交还终端。
 */

import { describe, expect, it } from "vitest";
import {
  clampWaitSeconds,
  createOnlineHub,
  type WaitOutcome,
} from "../src/main/workbench/online-hub";

function harness(graceMs = 60_000) {
  let now = 0;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const hub = createOnlineHub({
    now: () => now,
    schedule: (delay, fn) => {
      const timer = { at: now + delay, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    graceMs,
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
  return { hub, advance };
}

async function settled(promise: Promise<WaitOutcome>): Promise<WaitOutcome | "pending"> {
  return Promise.race([promise, new Promise<"pending">((r) => setTimeout(() => r("pending"), 5))]);
}

describe("在线监管", () => {
  it("不在线时不收提醒，调用方照常打进终端", () => {
    const { hub } = harness();
    expect(hub.isOnline("s")).toBe(false);
    expect(hub.offer("s", "[状态] x")).toBe(false);
    expect(hub.offerInbox("s")).toBe(false);
    expect(hub.requestStop("s")).toBe(false);
  });

  it("正在等时，事件一到就返回；没事件就到点返回", async () => {
    const { hub, advance } = harness();
    const first = hub.wait("s", 240_000);
    expect(hub.isOnline("s")).toBe(true);
    expect(hub.isWaiting("s")).toBe(true);
    expect(hub.offer("s", "[状态] 执行限流")).toBe(true);
    expect(await first).toEqual({
      events: ["[状态] 执行限流"],
      inbox: false,
      stop: false,
      timedOut: false,
    });
    const second = hub.wait("s", 240_000);
    expect(await settled(second)).toBe("pending");
    advance(240_000);
    expect(await second).toEqual({ events: [], inbox: false, stop: false, timedOut: true });
  });

  it("两次等待之间到达的事件先存着，下次一调用就返回（不丢、不走终端）", async () => {
    const { hub, advance } = harness();
    hub.offer("s", "noop");
    const first = hub.wait("s", 60_000);
    advance(60_000);
    await first;
    expect(hub.isOnline("s")).toBe(true);
    expect(hub.offer("s", "[锁] 轮到你了")).toBe(true);
    expect(hub.offerInbox("s")).toBe(true);
    expect(await hub.wait("s", 60_000)).toEqual({
      events: ["[锁] 轮到你了"],
      inbox: true,
      stop: false,
      timedOut: false,
    });
  });

  it("下线：正在等的调用拿到 stop，此后算离线，提醒回到终端", async () => {
    const { hub } = harness();
    const waiting = hub.wait("s", 240_000);
    expect(hub.requestStop("s")).toBe(true);
    expect(await waiting).toMatchObject({ stop: true, timedOut: false });
    expect(hub.isOnline("s")).toBe(false);
    expect(hub.offer("s", "[状态] x")).toBe(false);
  });

  it("很久没再调用就算离线，存着的事件交还给终端", async () => {
    const { hub, advance } = harness(60_000);
    const first = hub.wait("s", 10_000);
    advance(10_000);
    await first;
    expect(hub.offer("s", "[状态] 卡住了")).toBe(true);
    expect(hub.drainOffline()).toEqual([]);
    advance(60_001);
    expect(hub.isOnline("s")).toBe(false);
    expect(hub.drainOffline()).toEqual([
      { windowId: "s", events: ["[状态] 卡住了"], inbox: false },
    ]);
    expect(hub.drainOffline()).toEqual([]);
  });

  it("重复调用时旧的一次按超时交回；窗口退出时交回", async () => {
    const { hub } = harness();
    const old = hub.wait("s", 240_000);
    const fresh = hub.wait("s", 240_000);
    expect(await old).toMatchObject({ timedOut: true });
    hub.forget("s");
    expect(await fresh).toMatchObject({ timedOut: true });
    expect(hub.isOnline("s")).toBe(false);
  });

  it("等待秒数缺省 240，夹在 10 到 540", () => {
    expect(clampWaitSeconds(undefined)).toBe(240);
    expect(clampWaitSeconds(1)).toBe(10);
    expect(clampWaitSeconds(10_000)).toBe(540);
    expect(clampWaitSeconds(90.7)).toBe(90);
  });
});
