/**
 * T11.0d：退出前杀终端，等原生退出回调都送到再放行。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PtyManager } from "../src/main/terminal/manager";
import type { PtyHandle } from "../src/main/terminal/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeHandle(deliverAfterKillMs: number | null): PtyHandle & { delivered: boolean } {
  const handle = {
    pid: 4242,
    delivered: false,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      if (deliverAfterKillMs !== null) {
        setTimeout(() => {
          handle.delivered = true;
        }, deliverAfterKillMs);
      }
    }),
    onData: () => undefined,
    onExit: () => undefined,
    exitDelivered: () => handle.delivered,
  };
  return handle;
}

function managerWith(handles: PtyHandle[]): PtyManager {
  const queue = [...handles];
  return new PtyManager({
    factory: () => {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("no more fake handles");
      }
      return next;
    },
    outputFlushMs: 1,
    assignJob: () => undefined,
  });
}

function cwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-settle-"));
  dirs.push(dir);
  return dir;
}

describe("PtyManager.settleForQuit", () => {
  it("杀掉全部终端，等回调都送到才返回", async () => {
    const a = fakeHandle(30);
    const b = fakeHandle(80);
    const manager = managerWith([a, b]);
    manager.create({ cwd: cwd(), cols: 80, rows: 24 });
    manager.create({ cwd: cwd(), cols: 80, rows: 24 });
    expect(manager.hasUnsettledExits()).toBe(true);
    const left = await manager.settleForQuit(2000);
    expect(left).toBe(0);
    expect(a.kill).toHaveBeenCalled();
    expect(b.delivered).toBe(true);
    expect(manager.hasUnsettledExits()).toBe(false);
  });

  it("之前关掉、回调还没到的终端也要等", async () => {
    const closed = fakeHandle(60);
    const manager = managerWith([closed]);
    const info = manager.create({ cwd: cwd(), cols: 80, rows: 24 });
    manager.kill(info.id);
    expect(manager.size()).toBe(0);
    expect(manager.hasUnsettledExits()).toBe(true);
    expect(await manager.settleForQuit(2000)).toBe(0);
  });

  it("一直不到就按上限放行，返回还差几个", async () => {
    const stuck = fakeHandle(null);
    const manager = managerWith([stuck]);
    manager.create({ cwd: cwd(), cols: 80, rows: 24 });
    const started = Date.now();
    expect(await manager.settleForQuit(120)).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("不报告回调状态的终端当作已送到", async () => {
    const plain = fakeHandle(null);
    const { exitDelivered: _omit, ...withoutCheck } = plain;
    const manager = managerWith([withoutCheck]);
    manager.create({ cwd: cwd(), cols: 80, rows: 24 });
    expect(await manager.settleForQuit(1000)).toBe(0);
  });
});
