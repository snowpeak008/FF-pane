/**
 * PTY 管理器单测（假 pty）：生命周期、缓冲、批量、idle、清理、安全极值、IPC 收紧。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_EXITED_SESSIONS, PtyManager } from "../src/main/terminal/manager";
import { ByteRingBuffer } from "../src/main/terminal/ring-buffer";
import {
  assertTerminalCreateIpcSafe,
  clampTerminalDimension,
  MAX_TERMINAL_DIMENSION,
  resolveAllowedShell,
  TerminalValidationError,
} from "../src/main/terminal/shell";
import type {
  PtyFactory,
  PtyHandle,
  TerminalExitNotice,
  TerminalOutputBatch,
} from "../src/main/terminal/types";

interface FakePty extends PtyHandle {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  emitData(data: string): void;
  emitExit(exitCode: number): void;
}

function createFakeFactory(): {
  readonly factory: PtyFactory;
  readonly spawned: FakePty[];
} {
  const spawned: FakePty[] = [];
  let nextPid = 1000;
  const factory: PtyFactory = (options) => {
    const dataListeners: Array<(data: string) => void> = [];
    const exitListeners: Array<(event: { exitCode: number }) => void> = [];
    const handle: FakePty = {
      file: options.file,
      args: options.args,
      cwd: options.cwd,
      pid: nextPid++,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData(listener) {
        dataListeners.push(listener);
      },
      onExit(listener) {
        exitListeners.push(listener);
      },
      emitData(data) {
        for (const listener of dataListeners) {
          listener(data);
        }
      },
      emitExit(exitCode) {
        for (const listener of exitListeners) {
          listener({ exitCode });
        }
      },
    };
    spawned.push(handle);
    return handle;
  };
  return { factory, spawned };
}

describe("ByteRingBuffer", () => {
  it("截断超限字节（从头部丢弃）", () => {
    const buffer = new ByteRingBuffer(8);
    buffer.append("abcdefgh");
    buffer.append("IJ");
    expect(buffer.byteLength()).toBeLessThanOrEqual(8);
    expect(buffer.toString().endsWith("IJ")).toBe(true);
  });
});

describe("clampTerminalDimension", () => {
  it("钳到 [1, MAX]", () => {
    expect(clampTerminalDimension(0)).toBe(1);
    expect(clampTerminalDimension(-5)).toBe(1);
    expect(clampTerminalDimension(80)).toBe(80);
    expect(clampTerminalDimension(MAX_TERMINAL_DIMENSION + 100)).toBe(MAX_TERMINAL_DIMENSION);
    expect(clampTerminalDimension(Number.NaN)).toBe(1);
  });
});

describe("PtyManager（假 pty）", () => {
  let cwd: string;
  let now = 1_000_000;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ffpane-term-"));
    now = 1_000_000;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("create / write / resize / kill 基本路径；kill 后从 Map 删除", async () => {
    const { factory, spawned } = createFakeFactory();
    const batches: TerminalOutputBatch[] = [];
    const exits: TerminalExitNotice[] = [];
    const manager = new PtyManager({
      factory,
      now: () => now,
      outputFlushMs: 5,
      assignJob: () => undefined,
      listeners: {
        onOutputBatch: (batch) => batches.push(batch),
        onExit: (notice) => exits.push(notice),
      },
    });

    const created = manager.create({ cwd, cols: 80, rows: 24, metadata: { role: "plain" } });
    expect(created.id).toBeTruthy();
    expect(created.metadata).toEqual({ role: "plain" });
    expect(spawned).toHaveLength(1);

    manager.write(created.id, "hello");
    expect(spawned[0]?.write).toHaveBeenCalledWith("hello");

    manager.resize(created.id, 100, 40);
    expect(spawned[0]?.resize).toHaveBeenCalledWith(100, 40);

    spawned[0]?.emitData("out-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.getReplayBuffer(created.id)).toContain("out-1");

    manager.kill(created.id);
    expect(spawned[0]?.kill).toHaveBeenCalled();
    expect(exits.some((notice) => notice.id === created.id)).toBe(true);
    expect(manager.get(created.id)).toBeUndefined();
    expect(manager.size()).toBe(0);
    expect(() => manager.getReplayBuffer(created.id)).toThrow(/unknown terminal id/);
    manager.dispose();
  });

  it("环形缓冲超限截断", () => {
    const { factory, spawned } = createFakeFactory();
    const manager = new PtyManager({
      factory,
      outputBufferBytes: 16,
      outputFlushMs: 1,
      assignJob: () => undefined,
    });
    const created = manager.create({ cwd, cols: 40, rows: 12 });
    spawned[0]?.emitData("0123456789abcdefEXTRA");
    expect(manager.getReplayBuffer(created.id)).toContain("EXTRA");
    manager.dispose();
  });

  it("isIdle 按 lastOutputAt 判断", () => {
    const { factory, spawned } = createFakeFactory();
    const manager = new PtyManager({
      factory,
      now: () => now,
      assignJob: () => undefined,
    });
    const created = manager.create({ cwd, cols: 40, rows: 12 });
    expect(manager.isIdle(created.id, 100)).toBe(false);
    now += 50;
    expect(manager.isIdle(created.id, 100)).toBe(false);
    spawned[0]?.emitData("tick");
    now += 150;
    expect(manager.isIdle(created.id, 100)).toBe(true);
    manager.dispose();
  });

  it("自然退出保留快照；killAll 清空 Map", async () => {
    const { factory, spawned } = createFakeFactory();
    const exits: TerminalExitNotice[] = [];
    const manager = new PtyManager({
      factory,
      assignJob: () => undefined,
      listeners: { onExit: (notice) => exits.push(notice) },
    });
    const a = manager.create({ cwd, cols: 40, rows: 12 });
    const b = manager.create({ cwd, cols: 40, rows: 12 });
    spawned[0]?.emitExit(0);
    expect(exits).toContainEqual({ id: a.id, exitCode: 0 });
    expect(manager.get(a.id)?.exited).toBe(true);
    expect(manager.getReplayBuffer(a.id)).toBeDefined();

    await manager.killAll();
    expect(spawned[1]?.kill).toHaveBeenCalled();
    expect(manager.size()).toBe(0);
    expect(manager.get(b.id)).toBeUndefined();
    manager.dispose();
  });

  it("自然退出超过上限时淘汰最旧 exited", () => {
    const { factory, spawned } = createFakeFactory();
    let tick = 1_000_000;
    const manager = new PtyManager({
      factory,
      now: () => tick,
      maxExitedSessions: 2,
      assignJob: () => undefined,
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      tick += 1;
      const created = manager.create({ cwd, cols: 40, rows: 12 });
      ids.push(created.id);
      spawned[i]?.emitExit(0);
    }
    expect(manager.size()).toBe(2);
    expect(manager.get(ids[0] ?? "")).toBeUndefined();
    expect(manager.get(ids[1] ?? "")?.exited).toBe(true);
    expect(manager.get(ids[2] ?? "")?.exited).toBe(true);
    manager.dispose();
  });

  it("重启路径：反复 kill + create 不堆积 session", () => {
    const { factory } = createFakeFactory();
    const manager = new PtyManager({ factory, assignJob: () => undefined });
    for (let i = 0; i < 5; i += 1) {
      const created = manager.create({ cwd, cols: 40, rows: 12 });
      manager.kill(created.id);
    }
    expect(manager.size()).toBe(0);
    expect(manager.list()).toHaveLength(0);
    manager.dispose();
  });

  it("拒绝非法 shell、路径穿越、cwd 文件/缺失", () => {
    const { factory } = createFakeFactory();
    const manager = new PtyManager({ factory, assignJob: () => undefined });
    expect(() => manager.create({ cwd: join(cwd, "missing-dir"), cols: 40, rows: 12 })).toThrow(
      TerminalValidationError,
    );

    const asFile = join(cwd, "not-a-dir.txt");
    writeFileSync(asFile, "x");
    expect(() => manager.create({ cwd: asFile, cols: 40, rows: 12 })).toThrow(
      TerminalValidationError,
    );

    expect(() =>
      manager.create({ cwd, cols: 40, rows: 12, shell: "C:\\Windows\\System32\\calc.exe" }),
    ).toThrow(TerminalValidationError);
    expect(() =>
      manager.create({
        cwd,
        cols: 40,
        rows: 12,
        shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      }),
    ).toThrow(TerminalValidationError);
    expect(() =>
      manager.create({
        cwd,
        cols: 40,
        rows: 12,
        shell: "C:\\Windows\\System32\\powershell.exe\\..\\..\\calc.exe",
      }),
    ).toThrow(TerminalValidationError);
    expect(() => manager.create({ cwd, cols: 40, rows: 12, shell: "bash" })).toThrow(
      TerminalValidationError,
    );
    manager.dispose();
  });

  it("未知 id：write / resize / get-replay 抛错；kill 静默；resize 极值钳制", () => {
    const { factory, spawned } = createFakeFactory();
    const manager = new PtyManager({ factory, assignJob: () => undefined });
    const created = manager.create({ cwd, cols: 40, rows: 12 });

    expect(() => manager.write("no-such-id", "x")).toThrow(/unknown terminal id/);
    expect(() => manager.resize("no-such-id", 10, 10)).toThrow(/unknown terminal id/);
    expect(() => manager.getReplayBuffer("no-such-id")).toThrow(/unknown terminal id/);
    expect(() => manager.kill("no-such-id")).not.toThrow();

    manager.resize(created.id, 0, -3);
    expect(spawned[0]?.resize).toHaveBeenCalledWith(1, 1);
    manager.resize(created.id, 50_000, 50_000);
    expect(spawned[0]?.resize).toHaveBeenCalledWith(MAX_TERMINAL_DIMENSION, MAX_TERMINAL_DIMENSION);
    manager.dispose();
  });

  it("主进程内部仍可带 args（不经 IPC）", () => {
    const { factory, spawned } = createFakeFactory();
    const manager = new PtyManager({ factory, assignJob: () => undefined });
    manager.create({
      cwd,
      cols: 40,
      rows: 12,
      shell: "cmd",
      args: ["/d", "/c", "echo hi"],
      env: { FF_PANE_TEST: "1" },
    });
    expect(spawned[0]?.args).toEqual(["/d", "/c", "echo hi"]);
    manager.dispose();
  });
});

describe("IPC create 收紧与 shell 裸名", () => {
  it("assertTerminalCreateIpcSafe 拒绝 args / env", () => {
    expect(() => assertTerminalCreateIpcSafe({ cols: 80, rows: 24 })).not.toThrow();
    expect(() => assertTerminalCreateIpcSafe({ cols: 80, rows: 24, args: ["/c", "calc"] })).toThrow(
      TerminalValidationError,
    );
    expect(() =>
      assertTerminalCreateIpcSafe({ cols: 80, rows: 24, env: { PATH: "C:\\evil" } }),
    ).toThrow(TerminalValidationError);
  });

  it("resolveAllowedShell 拒绝绝对路径即便基名合法", () => {
    expect(() =>
      resolveAllowedShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    ).toThrow(/bare whitelist name/);
    expect(() => resolveAllowedShell("C:\\Windows\\System32\\calc.exe")).toThrow();
  });
});

// 压一下 MAX_EXITED_SESSIONS 常量被引用（防导出漂移）
describe("常量", () => {
  it("MAX_EXITED_SESSIONS 为正", () => {
    expect(MAX_EXITED_SESSIONS).toBeGreaterThan(0);
  });
});
