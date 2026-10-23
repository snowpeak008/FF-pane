/**
 * 终端应答闸门：窗格重挂载时 xterm 对回放里的旧问题再答一遍，
 * 应答的 ESC 打断 Codex 正在跑的一轮、余下字符被当成用户消息提交（2026-10-23 监管者窗口实录）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFromView } from "../src/main/terminal/handlers";
import { PtyManager } from "../src/main/terminal/manager";
import { TERMINAL_REPLY_WINDOW_MS, TerminalReplyGate } from "../src/main/terminal/reply-gate";
import type { PtyFactory, PtyHandle } from "../src/main/terminal/types";

/** Codex 启动时问的：DA1、前景色、背景色。 */
const CODEX_QUERIES = "\x1b[c\x1b]10;?\x1b\\\x1b]11;?\x1b\\";
/** 界面 xterm 的应答（实录里去掉 ESC 后就是 `[?1;2c]10;rgb:e7e7/eaea/f0f0\]11;rgb:0a0a/0d0d/1111\`）。 */
const XTERM_REPLIES = "\x1b[?1;2c\x1b]10;rgb:e7e7/eaea/f0f0\x1b\\\x1b]11;rgb:0a0a/0d0d/1111\x1b\\";

describe("TerminalReplyGate", () => {
  let now = 0;
  const gate = (): TerminalReplyGate => new TerminalReplyGate(() => now);

  beforeEach(() => {
    now = 1_000_000;
  });

  it("问过才放行：刚问的应答照写，用户按键原样保留但不含应答", () => {
    const g = gate();
    g.noteOutput(`banner\r\n${CODEX_QUERIES}`);
    const result = g.filterInput(`${XTERM_REPLIES}hi`);
    expect(result.data).toBe(`${XTERM_REPLIES}hi`);
    expect(result.typed).toBe("hi");
    expect(result.dropped).toBe(0);
  });

  it("没问过的应答丢掉：回放时 xterm 再答一遍，一个字节也不写进 PTY", () => {
    const result = gate().filterInput(XTERM_REPLIES);
    expect(result.data).toBe("");
    expect(result.typed).toBe("");
    expect(result.dropped).toBe(3);
  });

  it("过了时限的应答丢掉", () => {
    const g = gate();
    g.noteOutput(CODEX_QUERIES);
    now += TERMINAL_REPLY_WINDOW_MS + 1;
    expect(g.filterInput(XTERM_REPLIES).data).toBe("");
  });

  it("同一个问题答两遍：只放行第一遍", () => {
    const g = gate();
    g.noteOutput("\x1b[c");
    expect(g.filterInput("\x1b[?1;2c").data).toBe("\x1b[?1;2c");
    expect(g.filterInput("\x1b[?1;2c").data).toBe("");
  });

  it("OSC 按编号配对：问了背景色，前景色的旧应答不放行", () => {
    const g = gate();
    g.noteOutput("\x1b]11;?\x07");
    const result = g.filterInput(
      "\x1b]10;rgb:e7e7/eaea/f0f0\x1b\\\x1b]11;rgb:0a0a/0d0d/1111\x1b\\",
    );
    expect(result.data).toBe("\x1b]11;rgb:0a0a/0d0d/1111\x1b\\");
    expect(result.dropped).toBe(1);
  });

  it("问题被切成两块输出也认得出，不会重复记", () => {
    const g = gate();
    g.noteOutput("text\x1b]1");
    g.noteOutput("1;?\x1b\\ more");
    expect(g.filterInput("\x1b]11;rgb:0a0a/0d0d/1111\x1b\\").dropped).toBe(0);
    expect(g.filterInput("\x1b]11;rgb:0a0a/0d0d/1111\x1b\\").dropped).toBe(1);
  });

  it("用户按键不受影响：Esc、方向键、焦点、括号粘贴里的内容都原样写", () => {
    const g = gate();
    const keys = "\x1b\x1b[A\x1b[I\x1b[O\r";
    expect(g.filterInput(keys)).toEqual({ data: keys, typed: keys, dropped: 0 });
    const paste = "\x1b[200~粘贴里有 \x1b[?1;2c 也不动\x1b[201~";
    expect(g.filterInput(paste).data).toBe(paste);
  });

  it("光标位置、DECRQM 应答同样要先问过", () => {
    const g = gate();
    expect(g.filterInput("\x1b[12;1R\x1b[?2026;2$y").data).toBe("");
    g.noteOutput("\x1b[6n\x1b[?2026$p");
    expect(g.filterInput("\x1b[12;1R\x1b[?2026;2$y").data).toBe("\x1b[12;1R\x1b[?2026;2$y");
  });
});

interface FakePty extends PtyHandle {
  emitData(data: string): void;
}

function fakeFactory(): { readonly factory: PtyFactory; readonly spawned: FakePty[] } {
  const spawned: FakePty[] = [];
  const factory: PtyFactory = () => {
    const listeners: Array<(data: string) => void> = [];
    const handle: FakePty = {
      pid: 4242,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData(listener) {
        listeners.push(listener);
      },
      onExit() {},
      emitData(data) {
        for (const listener of listeners) {
          listener(data);
        }
      },
    };
    spawned.push(handle);
    return handle;
  };
  return { factory, spawned };
}

/** 新开一个 xterm，把回放写进去，收集它自动写回来的内容。 */
async function replayAnswers(replay: string): Promise<string[]> {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const answers: string[] = [];
  term.onData((data) => answers.push(data));
  await new Promise<void>((resolve) => term.write(replay, resolve));
  term.dispose();
  return answers;
}

describe("terminal:write 经过闸门（重挂载回放）", () => {
  let cwd: string;
  let now = 0;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ffpane-reply-"));
    now = 1_000_000;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("CLI 启动时的应答照写；几分钟后切回来回放，xterm 再答的那遍不进 PTY，也不算用户输入", async () => {
    const { factory, spawned } = fakeFactory();
    const manager = new PtyManager({ factory, now: () => now, assignJob: () => undefined });
    const onUserInput = vi.fn();
    const write = (data: string): void => writeFromView(manager, created.id, data, onUserInput);
    const created = manager.create({ cwd, cols: 80, rows: 24 });
    const pty = spawned[0];
    if (pty === undefined) {
      throw new Error("no pty");
    }

    pty.emitData(`codex banner\r\n${CODEX_QUERIES}› `);
    const live = await replayAnswers(manager.getReplayBuffer(created.id));
    expect(live.join("")).toContain("\x1b[?1;2c");
    for (const data of live) {
      write(data);
    }
    expect(pty.write).toHaveBeenCalledWith(expect.stringContaining("\x1b[?1;2c"));
    expect(onUserInput).not.toHaveBeenCalled();

    vi.mocked(pty.write).mockClear();
    now += 5 * 60_000;
    const remount = await replayAnswers(manager.getReplayBuffer(created.id));
    expect(remount.join("")).toContain("\x1b[?1;2c");
    for (const data of remount) {
      write(data);
    }
    expect(pty.write).not.toHaveBeenCalled();
    expect(onUserInput).not.toHaveBeenCalled();

    write("ok\r");
    expect(pty.write).toHaveBeenCalledWith("ok\r");
    expect(onUserInput).toHaveBeenCalledWith(created.id, "ok\r");
    manager.dispose();
  });
});
