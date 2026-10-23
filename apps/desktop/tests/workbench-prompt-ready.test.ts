/**
 * 重启后看到输入提示符判空闲、未知状态下「继续」也按回车、回车后核对结果直接回给调用方。
 * 屏幕样例取自真机（Claude Code 2.1.302、codex-cli 0.162.0，2026-10-21）。
 */

import { describe, expect, it } from "vitest";
import { parseCodexRolloutLine } from "../src/main/workbench/codex-rollout-watch";
import {
  createIdleDeliverQueue,
  DEFAULT_SUBMIT_VERIFY_MS,
  type SubmitResult,
} from "../src/main/workbench/idle-deliver";
import {
  createPromptWatch,
  inputStillHolds,
  readPromptScreen,
  sameModelName,
} from "../src/main/workbench/prompt-ready";

const RULE = "─".repeat(120);

const CLAUDE_IDLE = [
  " ▐▛███▛█   Claude Code v2.1.302",
  "▝▜██████▀  Opus 5.5 with high effort · API Usage Billing",
  " ▝▝   ▝▝   D:\\WorkWork\\Assist\\12333",
  "                                                                  ● high · /effort",
  RULE,
  "❯ ",
  RULE,
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

const CLAUDE_BUSY = [
  "● 我先读一下说明。",
  "✻ Thinking… (12s · esc to interrupt)",
  RULE,
  "❯ ",
  RULE,
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

const CLAUDE_TRUST = [
  RULE,
  " Accessing workspace:",
  " C:\\Users\\admin\\AppData\\Local\\Temp\\probe-cli\\work",
  " Security guide",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  " Enter to confirm · Esc to cancel",
]
  .map((line) => line.trimStart())
  .join("\n");

const CODEX_IDLE = [
  "  >_ OpenAI Codex (v0.162.0)",
  "  /model - choose what model and reasoning effort to use",
  "› Ask Codex to do anything",
  "  GPT-6.1-Sol high · ~\\AppData\\Local\\Temp\\probe-cli\\work",
  "  ? for shortcuts                                    ⚠ 1 warning · f2 to view",
].join("\n");

const CODEX_WORKING = [
  "› /model gpt-5.6-sol low",
  "◦ Working (2s • esc to interrupt)",
  "› Ask Codex to do anything",
  "  GPT-6.1-Sol high · ~\\AppData\\Local\\Temp\\probe-cli\\work",
  "  ? for shortcuts",
].join("\n");

const CODEX_STARTING = ["› /model", "  Waiting for startup  · esc cancel"].join("\n");

const CODEX_PICKER = [
  "  Select Model and Effort",
  "› 1. GPT-6.1-Sol (current)  Latest workhorse model for coding and everyday work.",
  "  2. GPT-6-Astra            Frontier intelligence for the most demanding work.",
  "  enter select · esc back",
].join("\n");

const CODEX_SWITCHED = [
  "• Model changed to gpt-6-astra xhigh for this session only",
  "› Ask Codex to do anything",
  "  ← for agents · ? for shortcuts",
].join("\n");

describe("读屏幕：是不是停在空闲的输入提示符上", () => {
  it("Claude：两条横线夹着的 ❯ 行算空闲，读出横幅里的模型和强度", () => {
    const screen = readPromptScreen(CLAUDE_IDLE, "claude-code");
    expect(screen).toMatchObject({ ready: true, busy: false, model: "Opus 5.5", effort: "high" });
  });

  it("Claude：干活时输入框也在，但有 esc to interrupt，不算空闲", () => {
    expect(readPromptScreen(CLAUDE_BUSY, "claude-code")).toMatchObject({
      ready: false,
      busy: true,
    });
  });

  it("Claude：信任目录对话框的 ❯ 选项不算输入框", () => {
    expect(readPromptScreen(CLAUDE_TRUST, "claude-code").ready).toBe(false);
  });

  it("Codex：› 行下面是状态行就算空闲，读出模型和强度", () => {
    expect(readPromptScreen(CODEX_IDLE, "codex")).toMatchObject({
      ready: true,
      model: "gpt-6.1-sol",
      effort: "high",
    });
  });

  it("Codex：Working、Waiting for startup、选择器都不算空闲", () => {
    expect(readPromptScreen(CODEX_WORKING, "codex").ready).toBe(false);
    expect(readPromptScreen(CODEX_STARTING, "codex").ready).toBe(false);
    expect(readPromptScreen(CODEX_PICKER, "codex").ready).toBe(false);
  });

  it("Codex：/model 切换后读「Model changed」那一行", () => {
    expect(readPromptScreen(CODEX_SWITCHED, "codex")).toMatchObject({
      ready: true,
      model: "gpt-6-astra",
      effort: "xhigh",
    });
  });

  it("Codex：有新版本时弹出的更新选择不算空闲", () => {
    const update = [
      "› Ask Codex to do anything",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "  enter continue · esc skip",
    ].join("\n");
    expect(readPromptScreen(update, "codex").ready).toBe(false);
  });

  it("Codex：切完状态行没重画时，以 Model changed 为准", () => {
    const stale = [
      "• Model changed to gpt-6.1-sol max for this session only",
      "› Ask Codex to do anything",
      "         GPT-6.1-Sol low · ~\\work · ← for agents",
      "  ← for agents · ? for shortcuts",
    ].join("\n");
    expect(readPromptScreen(stale, "codex")).toMatchObject({
      ready: true,
      model: "gpt-6.1-sol",
      effort: "max",
    });
  });

  it("看输入框里是不是还留着没提交的文字", () => {
    const nudge = "[继续] 上一轮被打断了（服务端错误）。从停下的地方接着做";
    const stuck = CLAUDE_IDLE.replace("❯ ", `❯ ${nudge}`);
    expect(inputStillHolds(stuck, "claude-code", nudge)).toBe(true);
    expect(inputStillHolds(CLAUDE_IDLE, "claude-code", nudge)).toBe(false);
    expect(inputStillHolds(CODEX_IDLE, "codex", nudge)).toBe(false);
    expect(
      inputStillHolds(
        CODEX_IDLE.replace("› Ask Codex to do anything", `› ${nudge}`),
        "codex",
        nudge,
      ),
    ).toBe(true);
    expect(inputStillHolds("没有输入框", "claude-code", nudge)).toBeUndefined();
  });

  it("输入框前面先有别的字、正文折到下一行：仍认出没提交（2026-10-23 监管者实录）", () => {
    const nudge = "[新消息] 你有 1 条新消息。请调用 ffpane_read_inbox 查看全文。";
    const junk = "[?1;2c]10;rgb:e7e7/eaea/f0f0\\]11;rgb:0a0a/0d0d/1111\\";
    const stuck = CODEX_IDLE.replace(
      "› Ask Codex to do anything",
      `› ${junk}[新消息] 你有 1\n  条新消息。请调用 ffpane_read_inbox 查看全文。`,
    );
    expect(inputStillHolds(stuck, "codex", nudge)).toBe(true);
    const otherOnly = CODEX_IDLE.replace("› Ask Codex to do anything", `› ${junk}`);
    expect(inputStillHolds(otherOnly, "codex", nudge)).toBe(false);
    const claudeWrapped = CLAUDE_IDLE.replace(
      "❯ ",
      `❯ 先前留下的字 [新消息] 你\n  有 1 条新消息。`,
    );
    expect(inputStillHolds(claudeWrapped, "claude-code", nudge)).toBe(true);
  });

  it("显示名和模型名按同一写法比较", () => {
    expect(sameModelName("GPT-6.1-Sol", "gpt-6.1-sol")).toBe(true);
    expect(sameModelName("GPT-6-Sol", "gpt-6.1-sol")).toBe(false);
  });
});

function harness(options: { readonly verify?: boolean; readonly turnSource?: boolean } = {}) {
  let now = 0;
  let lastOutput = -10_000;
  const writes: string[] = [];
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const queue = createIdleDeliverQueue({
    isIdle: (_id, quietMs) => now - lastOutput >= quietMs,
    isAlive: () => true,
    write: (_id, data) => {
      writes.push(data);
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
    outputQuietMs: 1000,
    inputQuietMs: 1000,
    pollMs: 200,
  });
  queue.attach("t1", {
    windowId: "w1",
    ...(options.verify === true ? { verifySubmit: true } : {}),
    ...(options.turnSource === true ? { turnStartSource: true } : {}),
  });
  return {
    queue,
    writes,
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

describe("看到输入提示符判空闲", () => {
  it("重启后状态未知：看到提示符就判空闲，排着的消息自动打出去", () => {
    const h = harness();
    expect(h.queue.enqueue({ terminalId: "t1", text: "hi" })).toEqual({
      status: "queued",
      mode: "manual",
    });
    expect(h.queue.notePromptReady("t1")).toBe(true);
    expect(h.queue.phaseOf("t1")).toBe("busy");
    expect(h.writes).toEqual(["hi", "\r"]);
  });

  it("带着初始提示启动的：要等输出安静很久才算", () => {
    const h = harness();
    h.queue.attach("t1", { initialPrompt: true });
    expect(h.queue.notePromptReady("t1")).toBe(false);
    expect(h.queue.phaseOf("t1")).toBe("unknown");
    expect(h.queue.notePromptReady("t1", { settled: true })).toBe(true);
    expect(h.queue.phaseOf("t1")).toBe("idle");
  });

  it("上一轮被打断一直显示忙：安静很久且屏幕空闲才清掉", () => {
    const h = harness();
    h.queue.noteHook("t1", "user-prompt-submit");
    expect(h.queue.notePromptReady("t1")).toBe(false);
    expect(h.queue.phaseOf("t1")).toBe("busy");
    expect(h.queue.notePromptReady("t1", { settled: true })).toBe(true);
    expect(h.queue.phaseOf("t1")).toBe("idle");
  });

  it("在等批准时不清", () => {
    const h = harness();
    h.queue.noteHook("t1", "permission-request", { toolUseId: "tool-1" });
    expect(h.queue.notePromptReady("t1", { settled: true })).toBe(false);
    expect(h.queue.phaseOf("t1")).toBe("blocked");
  });

  it("监视器只在状态未知或忙时看屏幕，同一段输出只看一次", async () => {
    let now = 10_000;
    let renders = 0;
    let phase: "unknown" | "busy" | "idle" = "unknown";
    const ready: string[] = [];
    const watch = createPromptWatch({
      targets: () => [{ terminalId: "t1", windowId: "w1", runtime: "codex", lastOutputAt: 9000 }],
      phaseOf: () => phase,
      render: async () => {
        renders += 1;
        return CODEX_IDLE;
      },
      notePromptReady: () => {
        phase = "idle";
        return true;
      },
      onReady: (windowId) => {
        ready.push(windowId);
      },
      now: () => now,
    });
    await watch.tick();
    expect(ready).toEqual(["w1"]);
    await watch.tick();
    expect(renders).toBe(1);
    phase = "busy";
    now = 12_000;
    await watch.tick();
    // 忙着只安静了 3 秒：不看。
    expect(renders).toBe(1);
  });
});

describe("未知状态下的「继续」与提交结果", () => {
  it("allowUnknown 的条目在状态未知时等静默后自动投递", () => {
    const h = harness();
    expect(
      h.queue.enqueue({ terminalId: "t1", text: "[继续] 接着做", allowUnknown: true }),
    ).toEqual({ status: "delivered" });
    expect(h.writes).toEqual(["[继续] 接着做", "\r"]);
  });

  it("普通消息在状态未知时仍然等手动确认", () => {
    const h = harness();
    expect(h.queue.enqueue({ terminalId: "t1", text: "hi" })).toEqual({
      status: "queued",
      mode: "manual",
    });
    expect(h.writes).toEqual([]);
  });

  it("有回合信号：信号来了回 submitted", () => {
    const h = harness({ verify: true, turnSource: true });
    h.queue.noteHook("t1", "stop");
    const results: SubmitResult[] = [];
    h.queue.enqueue({ terminalId: "t1", text: "hi", onSubmit: (r) => results.push(r) });
    h.advance(100);
    h.queue.noteTurnStarted("t1");
    h.advance(DEFAULT_SUBMIT_VERIFY_MS);
    expect(results).toEqual(["submitted"]);
  });

  it("没开始一轮：补一次回车，还不行就回 not-submitted", () => {
    const h = harness({ verify: true, turnSource: true });
    h.queue.noteHook("t1", "stop");
    h.advance(2000);
    const results: SubmitResult[] = [];
    h.queue.enqueue({ terminalId: "t1", text: "hi", onSubmit: (r) => results.push(r) });
    h.advance(DEFAULT_SUBMIT_VERIFY_MS * 2 + 10);
    expect(h.writes).toEqual(["hi", "\r", "\r"]);
    expect(results).toEqual(["not-submitted"]);
    expect(h.queue.phaseOf("t1")).toBe("unknown");
  });

  it("不核对的终端：写出回车就回 unverified", () => {
    const h = harness();
    h.queue.noteHook("t1", "stop");
    const results: SubmitResult[] = [];
    h.queue.enqueue({ terminalId: "t1", text: "hi", onSubmit: (r) => results.push(r) });
    expect(results).toEqual(["unverified"]);
  });

  it("排着没打出去就退出：回 dropped", () => {
    const h = harness();
    const results: SubmitResult[] = [];
    h.queue.enqueue({ terminalId: "t1", text: "hi", onSubmit: (r) => results.push(r) });
    h.queue.drop("t1");
    expect(results).toEqual(["dropped"]);
  });

  it("跑过一轮才算聊过天", () => {
    const h = harness();
    expect(h.queue.hadTurn("t1")).toBe(false);
    h.queue.noteSubmit("t1");
    expect(h.queue.hadTurn("t1")).toBe(true);
  });

  it("暂停期间不自动投递，恢复后补上", () => {
    const h = harness();
    h.queue.noteHook("t1", "stop");
    h.queue.setPaused("t1", true);
    h.queue.enqueue({ terminalId: "t1", text: "hi" });
    expect(h.writes).toEqual([]);
    h.queue.setPaused("t1", false);
    expect(h.writes).toEqual(["hi", "\r"]);
  });
});

describe("Codex rollout：被打断的一轮", () => {
  it("turn_aborted 读成 turn-aborted", () => {
    const line = JSON.stringify({
      timestamp: "2026-08-15T13:42:14.000Z",
      type: "event_msg",
      payload: { type: "turn_aborted", turn_id: "x", reason: "interrupted" },
    });
    expect(parseCodexRolloutLine(line)).toEqual({ kind: "turn-aborted" });
  });
});
