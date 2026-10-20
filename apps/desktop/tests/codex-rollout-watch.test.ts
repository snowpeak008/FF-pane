/**
 * Codex rollout 回合信号：解析、错误类型、按会话编号找文件、只读新增行。
 */

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexErrorType,
  codexRolloutPathFor,
  codexThreadIdTimeMs,
  parseCodexRolloutLine,
  tailCodexRollout,
} from "../src/main/workbench/codex-rollout-watch";
import { createIdleDeliverQueue } from "../src/main/workbench/idle-deliver";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const started = JSON.stringify({
  type: "event_msg",
  payload: { type: "task_started", turn_id: "t" },
});
const completed = JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } });
// 真机 codex-cli 0.162.0 出错时 task_complete 的样子（模型不存在）。
const failed = JSON.stringify({
  type: "event_msg",
  payload: {
    type: "task_complete",
    error: {
      message:
        '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'x\' model is not supported when using Codex with a ChatGPT account."}}',
    },
  },
});

describe("rollout 解析", () => {
  it("只认 task_started / task_complete，出错带错误类型", () => {
    expect(parseCodexRolloutLine(started)).toEqual({ kind: "turn-started" });
    expect(parseCodexRolloutLine(completed)).toEqual({ kind: "turn-complete" });
    expect(parseCodexRolloutLine(failed)).toEqual({
      kind: "turn-complete",
      errorType: "model_not_found",
    });
    expect(
      parseCodexRolloutLine(
        JSON.stringify({ type: "response_item", payload: { type: "message" } }),
      ),
    ).toBeUndefined();
    expect(parseCodexRolloutLine("{not json event_msg")).toBeUndefined();
  });

  it("错误类型换算和 Claude StopFailure 一致", () => {
    expect(codexErrorType({ message: '{"status":429,"error":{"type":"rate_limit_error"}}' })).toBe(
      "rate_limit",
    );
    expect(codexErrorType("usage_limit_reached")).toBe("rate_limit");
    expect(codexErrorType({ message: '{"status":401}' })).toBe("authentication_failed");
    expect(codexErrorType({ message: '{"status":503}' })).toBe("overloaded");
    expect(codexErrorType({ message: '{"status":500}' })).toBe("server_error");
    expect(codexErrorType({ message: '{"status":400,"type":"invalid_request_error"}' })).toBe(
      "invalid_request",
    );
    expect(codexErrorType({ message: "stream disconnected" })).toBe("unknown");
  });
});

describe("按会话编号找自己的文件", () => {
  it("用编号里的时间拼出文件名逐个查是否存在，不列目录、不碰别的会话", () => {
    // 真机：编号 01a1588d-18e8-77a3-… 的时间是本地 17:03:24，文件名是 17-03-25。
    const id = "01a1588d-18e8-77a3-b90f-e5fcfd74f597";
    const created = new Date(codexThreadIdTimeMs(id) ?? 0);
    const later = new Date(created.getTime() + 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const y = String(later.getFullYear());
    const m = pad(later.getMonth() + 1);
    const d = pad(later.getDate());
    const stamp = `${y}-${m}-${d}T${pad(later.getHours())}-${pad(later.getMinutes())}-${pad(later.getSeconds())}`;
    const expected = join("S", y, m, d, `rollout-${stamp}-${id}.jsonl`);
    const probed: string[] = [];
    const found = codexRolloutPathFor("S", id, (path) => {
      probed.push(path);
      return path === expected;
    });
    expect(found).toBe(expected);
    expect(probed.every((path) => path.endsWith(`-${id}.jsonl`))).toBe(true);
    expect(codexRolloutPathFor("S", id, () => false)).toBeUndefined();
  });

  it("不是带时间的编号（非 v7）就不找", () => {
    expect(codexThreadIdTimeMs("11111111-1111-4111-8111-111111111111")).toBeUndefined();
    expect(
      codexRolloutPathFor("S", "11111111-1111-4111-8111-111111111111", () => true),
    ).toBeUndefined();
  });

  it("源码里不列目录", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      join(__dirname, "..", "src", "main", "workbench", "codex-rollout-watch.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/readdirSync|readdir\(/);
  });
});

describe("只读新增行", () => {
  it("从当时的末尾开始；半行和被切开的多字节字符等整行到了再解析", () => {
    const dir = mkdtempSync(join(tmpdir(), "ffpane-tail-"));
    roots.push(dir);
    const file = join(dir, "rollout.jsonl");
    writeFileSync(file, `${started}\n`);
    let tick: () => void = () => undefined;
    const events: unknown[] = [];
    const tail = tailCodexRollout(file, (event) => events.push(event), {
      schedule: (fn) => {
        tick = fn;
        return () => undefined;
      },
    });
    tick();
    expect(events).toEqual([]);
    const withChinese = JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", error: { message: "限流 status 429" } },
    });
    const bytes = Buffer.from(`${withChinese}\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("限", "utf8")) + 1;
    appendFileSync(file, bytes.subarray(0, cut));
    tick();
    expect(events).toEqual([]);
    appendFileSync(file, bytes.subarray(cut));
    appendFileSync(file, `${started}\n`);
    tick();
    expect(events).toEqual([
      { kind: "turn-complete", errorType: "rate_limit" },
      { kind: "turn-started" },
    ]);
    tail.stop();
    appendFileSync(file, `${completed}\n`);
    tick();
    expect(events).toHaveLength(2);
  });
});

describe("投递队列按真信号核对提交", () => {
  it("有一轮开始的信号就不补回车；没有就补，补了还没有就报没提交", () => {
    let now = 0;
    const writes: string[] = [];
    const deferred: unknown[] = [];
    const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
    const queue = createIdleDeliverQueue({
      isIdle: () => true,
      isAlive: () => true,
      write: (_id, data) => {
        writes.push(data);
      },
      // 终端一直在刷新：只看输出会以为提交了。有真信号来源时不应被它骗过。
      lastOutputAt: () => now,
      now: () => now,
      schedule: (delay, fn) => {
        const timer = { at: now + delay, fn, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      onDeferred: (outcome) => deferred.push(outcome),
      outputQuietMs: 0,
      inputQuietMs: 0,
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
    queue.attach("t", { windowId: "w", verifySubmit: true });
    queue.setTurnStartSource("t", true);
    queue.noteHook("t", "stop");

    queue.enqueue({ terminalId: "t", text: "甲" });
    advance(1000);
    queue.noteTurnStarted("t");
    advance(10_000);
    expect(writes.filter((w) => w === "\r")).toHaveLength(1);

    queue.noteHook("t", "stop");
    queue.enqueue({ terminalId: "t", text: "乙" });
    advance(10_000);
    expect(writes.filter((w) => w === "\r")).toHaveLength(3);
    expect(deferred).toEqual([
      { terminalId: "t", status: "dropped", reason: "not-submitted", tag: "w" },
    ]);
  });
});
