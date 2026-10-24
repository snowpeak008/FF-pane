/**
 * T11.0：输入框里有用户的字就不投递。
 */

import { describe, expect, it } from "vitest";
import {
  createIdleDeliverQueue,
  type DeliverPendingNotice,
  DRAFT_RECHECK_MS,
  UNSEEN_DRAFT_QUIET_MS,
} from "../src/main/workbench/idle-deliver";
import { renderTerminalText } from "../src/main/workbench/output-text";
import { inputHasText } from "../src/main/workbench/prompt-ready";

function harness() {
  let now = 100_000;
  let lastOutput = 0;
  let draft: boolean | undefined = false;
  let reads = 0;
  const writes: string[] = [];
  const pending: DeliverPendingNotice[] = [];
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const queue = createIdleDeliverQueue({
    isIdle: (_id, quietMs) => now - lastOutput >= quietMs,
    isAlive: () => true,
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
    readDraft: async () => {
      reads += 1;
      return draft;
    },
    onPending: (notice) => {
      pending.push(notice);
    },
    outputQuietMs: 1000,
    inputQuietMs: 1000,
    pollMs: 200,
  });
  /** 推进时间，每触发一个定时器就让读屏的 Promise 落定。 */
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      await Promise.resolve();
      await Promise.resolve();
      const next = timers
        .filter((timer) => !timer.cancelled && timer.at > now && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (next === undefined) {
        now = target;
        await Promise.resolve();
        await Promise.resolve();
        return;
      }
      now = next.at;
      next.cancelled = true;
      next.fn();
    }
  };
  queue.attach("t1");
  queue.noteHook("t1", "stop");
  return {
    queue,
    writes,
    pending,
    advance,
    reads: () => reads,
    setDraft(value: boolean | undefined) {
      draft = value;
    },
    type() {
      queue.noteInput("t1", now);
    },
  };
}

describe("输入框有字就不投", () => {
  it("用户没按过键：照常当场投递，不看屏幕", () => {
    const h = harness();
    expect(h.queue.enqueue({ terminalId: "t1", text: "hello" })).toEqual({ status: "delivered" });
    expect(h.writes).toEqual(["hello", "\r"]);
    expect(h.reads()).toBe(0);
  });

  it("用户打了半句停下：不投，等用户发出、这一轮做完再投", async () => {
    const h = harness();
    h.type();
    await h.advance(5000);
    h.setDraft(true);
    expect(h.queue.enqueue({ terminalId: "t1", text: "hello" })).toEqual({
      status: "queued",
      mode: "draft",
    });
    await h.advance(30_000);
    expect(h.writes).toEqual([]);
    expect(h.pending.at(-1)?.mode).toBe("draft");
    // 隔一段时间才再看一次，不是每次轮询都读屏。
    expect(h.reads()).toBeLessThanOrEqual(30_000 / DRAFT_RECHECK_MS + 1);
    // 用户回车：一轮开始（框清空），做完后 Stop。
    h.queue.noteInput("t1");
    h.queue.noteSubmit("t1");
    h.queue.noteHook("t1", "user-prompt-submit");
    h.setDraft(false);
    await h.advance(3000);
    expect(h.writes).toEqual([]);
    h.queue.noteHook("t1", "stop");
    await h.advance(2000);
    expect(h.writes).toEqual(["hello", "\r"]);
  });

  it("用户按过键但框已经空了（删光了）：看一眼就投", async () => {
    const h = harness();
    h.type();
    await h.advance(5000);
    h.setDraft(false);
    h.queue.enqueue({ terminalId: "t1", text: "hello" });
    await h.advance(10);
    expect(h.writes).toEqual(["hello", "\r"]);
    expect(h.reads()).toBe(1);
  });

  it("看不出框里有没有字：用户 60 秒内按过键就不投，之后再投", async () => {
    const h = harness();
    h.type();
    h.setDraft(undefined);
    h.queue.enqueue({ terminalId: "t1", text: "hello" });
    await h.advance(UNSEEN_DRAFT_QUIET_MS - 5000);
    expect(h.writes).toEqual([]);
    await h.advance(10_000);
    expect(h.writes).toEqual(["hello", "\r"]);
  });

  it("输入法选词期间不投，选完框里有字也不投", async () => {
    const h = harness();
    h.queue.noteComposing("t1", true);
    expect(h.queue.enqueue({ terminalId: "t1", text: "hello" })).toEqual({
      status: "queued",
      mode: "draft",
    });
    await h.advance(20_000);
    expect(h.writes).toEqual([]);
    expect(h.reads()).toBe(0);
    h.setDraft(true);
    h.queue.noteComposing("t1", false);
    await h.advance(20_000);
    expect(h.writes).toEqual([]);
    h.setDraft(false);
    await h.advance(5000);
    expect(h.writes).toEqual(["hello", "\r"]);
  });

  it("立即发送：框里有字或正在选词时拒绝", () => {
    const h = harness();
    h.queue.noteHook("t1", "session-start");
    const fresh = createIdleDeliverQueue({
      isIdle: () => false,
      isAlive: () => true,
      write: () => undefined,
      now: () => 1000,
      schedule: () => () => undefined,
    });
    fresh.attach("t2");
    fresh.enqueue({ terminalId: "t2", text: "hello" });
    expect(fresh.deliverNow("t2", { draft: true })).toEqual({
      status: "refused",
      reason: "draft",
    });
    fresh.noteComposing("t2", true);
    expect(fresh.deliverNow("t2")).toEqual({ status: "refused", reason: "draft" });
    fresh.noteComposing("t2", false);
    expect(fresh.deliverNow("t2")).toEqual({ status: "delivered", count: 1 });
  });

  it("一轮真正开始（Codex task_started）后不用再看屏幕", () => {
    const h = harness();
    h.type();
    expect(h.queue.needsDraftCheck("t1")).toBe(true);
    h.queue.noteTurnStarted("t1");
    expect(h.queue.needsDraftCheck("t1")).toBe(false);
  });
});

describe("读输入框里用户打的字", () => {
  const claude = (input: string): string =>
    ["─".repeat(40), input, "─".repeat(40), "  ⏵⏵ auto mode on"].join("\r\n");
  const codex = (input: string): string =>
    [input, "", "  GPT-6-Astra high · ~\\repo", "  ? for shortcuts"].join("\r\n");

  it("提示文字是暗色、光标格是反色，都不算；正常颜色的字才算", async () => {
    const size = { cols: 80, rows: 10 };
    const placeholder = await renderTerminalText(
      codex("› \u001b[2mAsk Codex to do anything\u001b[0m"),
      size,
      20,
      { solidOnly: true },
    );
    expect(inputHasText(placeholder, "codex")).toBe(false);
    const typed = await renderTerminalText(codex("› abc"), size, 20, { solidOnly: true });
    expect(inputHasText(typed, "codex")).toBe(true);
    const claudeHint = await renderTerminalText(
      claude('❯ \u001b[7mT\u001b[0m\u001b[2mry "fix lint errors"\u001b[0m'),
      size,
      20,
      { solidOnly: true },
    );
    expect(inputHasText(claudeHint, "claude-code")).toBe(false);
    const claudeTyped = await renderTerminalText(
      claude("❯ 帮我看看\u001b[7m \u001b[0m"),
      size,
      20,
      { solidOnly: true },
    );
    expect(inputHasText(claudeTyped, "claude-code")).toBe(true);
  });

  it("不用 solidOnly 时提示文字会被当成字（所以投递前必须用 solidOnly）", async () => {
    const plain = await renderTerminalText(
      codex("› \u001b[2mAsk Codex to do anything\u001b[0m"),
      { cols: 80, rows: 10 },
      20,
    );
    expect(inputHasText(plain, "codex")).toBe(true);
  });

  it("ConPTY 写满一整行的横线后不换行：按屏幕行读才认得出 Claude 输入框", async () => {
    const cols = 40;
    const rule = "─".repeat(cols);
    // 真机录到的样子：横线写满一行，紧接着就是下一行的内容，中间没有回车换行。
    const raw = `${rule}❯ abc${" ".repeat(cols - 5)}${rule}  ⏵⏵ auto mode on`;
    const size = { cols, rows: 6 };
    const joined = await renderTerminalText(raw, size, 20, { solidOnly: true });
    expect(inputHasText(joined, "claude-code")).toBeUndefined();
    const rows = await renderTerminalText(raw, size, 20, { solidOnly: true, keepRows: true });
    expect(inputHasText(rows, "claude-code")).toBe(true);
  });

  it("看不到输入框（对话框、选择器）返回 undefined", () => {
    expect(inputHasText("› 1. Trust and continue\n  2. Back", "codex")).toBeUndefined();
    expect(inputHasText("hello", "claude-code")).toBeUndefined();
  });
});
