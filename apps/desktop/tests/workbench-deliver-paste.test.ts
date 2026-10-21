/**
 * 回车被吃成换行（2026-10-21 真机复现：Claude Code 2.1.302 把长串中文当粘贴，紧跟的回车变成换行，
 * 之后单独补的回车也不提交）：括号粘贴写正文；没提交就清掉输入框重打一遍；还不行就清掉再报，
 * 不让文字留在输入框里越堆越多。同一句还排着时不再排第二份。
 */

import { describe, expect, it } from "vitest";
import {
  CLEAR_INPUT_KEYS,
  createIdleDeliverQueue,
  DEFAULT_SUBMIT_VERIFY_MS,
  type SubmitResult,
} from "../src/main/workbench/idle-deliver";

/** 让看屏幕的异步回调跑完。 */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

function harness(look?: (text: string) => boolean | undefined) {
  let now = 10_000;
  const lastOutput = 0;
  const writes: string[] = [];
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const queue = createIdleDeliverQueue({
    isIdle: (_id, quietMs) => now - lastOutput >= quietMs,
    isAlive: () => true,
    write: (_id, data) => {
      writes.push(data);
    },
    lastOutputAt: () => lastOutput,
    ...(look !== undefined
      ? { inputStillHolds: async (_id: string, text: string) => look(text) }
      : {}),
    now: () => now,
    schedule: (delayMs, fn) => {
      const timer = { at: now + delayMs, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    outputQuietMs: 1000,
    inputQuietMs: 1000,
    pollMs: 200,
  });
  queue.attach("t1", {
    windowId: "w1",
    verifySubmit: true,
    turnStartSource: true,
    bracketedPaste: true,
    clearInput: CLEAR_INPUT_KEYS,
  });
  queue.noteHook("t1", "stop");
  return {
    queue,
    writes,
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

describe("括号粘贴与没提交时清空", () => {
  it("正文用括号粘贴包起来，回车单独写", () => {
    const h = harness();
    h.queue.enqueue({ terminalId: "t1", text: "[继续] 接着做" });
    expect(h.writes).toEqual([`${PASTE_START}[继续] 接着做${PASTE_END}`, "\r"]);
  });

  it("没提交、屏幕上看得到它还在输入框里：清掉重打一遍，这次提交了就算成功", async () => {
    const h = harness(() => true);
    const results: SubmitResult[] = [];
    h.queue.enqueue({ terminalId: "t1", text: "hi", onSubmit: (r) => results.push(r) });
    h.advance(DEFAULT_SUBMIT_VERIFY_MS);
    await settle();
    expect(h.writes).toEqual([
      `${PASTE_START}hi${PASTE_END}`,
      "\r",
      CLEAR_INPUT_KEYS,
      `${PASTE_START}hi${PASTE_END}`,
      "\r",
    ]);
    h.advance(100);
    h.queue.noteTurnStarted("t1");
    h.advance(DEFAULT_SUBMIT_VERIFY_MS);
    expect(results).toEqual(["submitted"]);
  });

  it("重打也没提交：清掉再报 not-submitted，输入框里不留东西", async () => {
    const h = harness(() => true);
    const results: SubmitResult[] = [];
    h.queue.enqueue({ terminalId: "t1", text: "hi", onSubmit: (r) => results.push(r) });
    h.advance(DEFAULT_SUBMIT_VERIFY_MS);
    await settle();
    h.advance(DEFAULT_SUBMIT_VERIFY_MS + 10);
    await settle();
    expect(results).toEqual(["not-submitted"]);
    expect(h.writes.at(-1)).toBe(CLEAR_INPUT_KEYS);
    // 下一条不会接在旧文字后面：前面紧挨着的是一次清空。
    h.queue.noteHook("t1", "stop");
    h.advance(2000);
    h.queue.enqueue({ terminalId: "t1", text: "second" });
    expect(h.writes.slice(-3)).toEqual([
      CLEAR_INPUT_KEYS,
      `${PASTE_START}second${PASTE_END}`,
      "\r",
    ]);
  });

  it("看不出输入框里有没有：只补回车，不清不重打（免得发两遍）", async () => {
    const h = harness(() => undefined);
    const results: SubmitResult[] = [];
    h.queue.enqueue({ terminalId: "t1", text: "hi", onSubmit: (r) => results.push(r) });
    h.advance(DEFAULT_SUBMIT_VERIFY_MS);
    await settle();
    expect(h.writes).toEqual([`${PASTE_START}hi${PASTE_END}`, "\r", "\r"]);
    h.advance(DEFAULT_SUBMIT_VERIFY_MS + 10);
    await settle();
    expect(results).toEqual(["not-submitted"]);
    expect(h.writes).not.toContain(CLEAR_INPUT_KEYS);
  });

  it("信号说没提交、但输入框已经空了：算提交，不重打（免得发两遍）", async () => {
    const h = harness(() => false);
    const results: SubmitResult[] = [];
    h.queue.enqueue({ terminalId: "t1", text: "hi", onSubmit: (r) => results.push(r) });
    h.advance(DEFAULT_SUBMIT_VERIFY_MS);
    await Promise.resolve();
    expect(results).toEqual(["submitted"]);
    expect(h.writes).toEqual([`${PASTE_START}hi${PASTE_END}`, "\r"]);
  });

  it("输入框里还留着这段：清掉重打", async () => {
    const h = harness(() => true);
    h.queue.enqueue({ terminalId: "t1", text: "hi" });
    h.advance(DEFAULT_SUBMIT_VERIFY_MS);
    await Promise.resolve();
    expect(h.writes.slice(2)).toEqual([CLEAR_INPUT_KEYS, `${PASTE_START}hi${PASTE_END}`, "\r"]);
  });

  it("同一句还排着：不再排第二份", () => {
    const h = harness();
    h.queue.noteHook("t1", "user-prompt-submit");
    const first = h.queue.enqueue({ terminalId: "t1", text: "[继续] 接着做" });
    const second = h.queue.enqueue({ terminalId: "t1", text: "[继续] 接着做" });
    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    expect(h.queue.pendingCount("t1")).toBe(1);
  });
});
