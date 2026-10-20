/**
 * 回放缓冲截头后还原终端模式：Claude Code 启动时藏的光标、开的括号粘贴，
 * 截掉之后重放仍然生效（2026-10-20 管理者窗口光标乱跳的根因）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtyManager } from "../src/main/terminal/manager";
import { TerminalModeState } from "../src/main/terminal/mode-state";
import { ByteRingBuffer } from "../src/main/terminal/ring-buffer";
import type { PtyFactory, PtyHandle } from "../src/main/terminal/types";

/** Claude Code 2.1.302 启动时实录的模式序列（节选）。 */
const CLAUDE_STARTUP =
  "\x1b[?2004h\x1b[?1004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2026h\x1b[?2026l\x1b[?25l";

function cursorHidden(term: Terminal): boolean {
  return (term as unknown as { _core: { coreService: { isCursorHidden: boolean } } })._core
    .coreService.isCursorHidden;
}

async function replayInto(data: string): Promise<Terminal> {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(data, resolve));
  return term;
}

describe("TerminalModeState", () => {
  it("只记 DEC 私有模式的最后取值，按最后设置的先后输出", () => {
    const state = new TerminalModeState();
    state.feed("\x1b[?1000h hello \x1b[?25l\x1b[?1000;1006h\x1b[?25h\x1b[?25l");
    expect(state.prelude()).toBe("\x1b[?1000h\x1b[?1006h\x1b[?25l");
  });

  it("同步输出（?2026）不还原，免得重放后画面冻住；不认识的模式也不记", () => {
    const state = new TerminalModeState();
    state.feed("\x1b[?2026h\x1b[?9001l\x1b[?12345h");
    expect(state.prelude()).toBe("");
  });

  it("序列被切成两块也能认出来", () => {
    const state = new TerminalModeState();
    state.feed("text\x1b[?2");
    state.feed("5l more");
    state.feed("\x1b");
    state.feed("[?2004h");
    expect(state.prelude()).toBe("\x1b[?25l\x1b[?2004h");
  });
});

describe("ByteRingBuffer onEvict", () => {
  it("按写入顺序交出被挤掉的输出，大块只交前半截", () => {
    const evicted: string[] = [];
    const buffer = new ByteRingBuffer(8, (dropped) => evicted.push(dropped.toString("utf8")));
    buffer.append("abcd");
    buffer.append("efgh");
    buffer.append("ij");
    expect(evicted).toEqual(["abcd"]);
    buffer.append("0123456789");
    expect(evicted).toEqual(["abcd", "efgh", "ij", "01"]);
    expect(buffer.toString()).toBe("23456789");
  });
});

describe("PtyManager 回放", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ffpane-mode-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function fakeFactory(): { factory: PtyFactory; emit: (data: string) => void; handle: PtyHandle } {
    const listeners: Array<(data: string) => void> = [];
    const handle: PtyHandle = {
      pid: 4242,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (listener) => {
        listeners.push(listener);
      },
      onExit: () => undefined,
    };
    return {
      factory: () => handle,
      emit: (data) => {
        for (const listener of listeners) {
          listener(data);
        }
      },
      handle,
    };
  }

  it("启动序列被挤出缓冲后，重放出来光标仍藏着、括号粘贴仍开着", async () => {
    const { factory, emit } = fakeFactory();
    const manager = new PtyManager({
      factory,
      outputBufferBytes: 4096,
      outputFlushMs: 1,
      assignJob: () => undefined,
    });
    const created = manager.create({ cwd, cols: 80, rows: 24 });
    emit(CLAUDE_STARTUP);
    for (let i = 0; i < 200; i += 1) {
      emit(`\x1b[27;3H输入第 ${i} 次\x1b[7m \x1b[27m\x1b[25;60H\x1b[K\x1b[18C`);
    }
    const replay = manager.getReplayBuffer(created.id);
    expect(replay).not.toContain(CLAUDE_STARTUP);

    const restored = await replayInto(replay);
    expect(cursorHidden(restored)).toBe(true);
    expect(restored.modes.bracketedPasteMode).toBe(true);
    expect(restored.modes.mouseTrackingMode).toBe("any");

    const withoutPrelude = await replayInto(replay.slice(replay.indexOf("\x1b[27;3H")));
    expect(cursorHidden(withoutPrelude)).toBe(false);
    manager.dispose();
  });

  it("行列没变不再调伪终端尺寸（ConPTY 每调一次都整屏重画）", () => {
    const { factory, handle } = fakeFactory();
    const manager = new PtyManager({ factory, outputFlushMs: 1, assignJob: () => undefined });
    const created = manager.create({ cwd, cols: 80, rows: 24 });
    manager.resize(created.id, 80, 24);
    expect(handle.resize).not.toHaveBeenCalled();
    manager.resize(created.id, 80, 23);
    manager.resize(created.id, 80, 23);
    expect(handle.resize).toHaveBeenCalledTimes(1);
    expect(handle.resize).toHaveBeenCalledWith(80, 23);
    manager.dispose();
  });
});
