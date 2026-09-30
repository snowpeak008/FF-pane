/**
 * 主进程窗口上限强制校验（T10.2）。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isWorkbenchWindowLimitError,
  WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX,
} from "../src/main/terminal/handlers";
import { PtyManager } from "../src/main/terminal/manager";
import type { PtyFactory, PtyHandle } from "../src/main/terminal/types";

function fakeHandle(): PtyHandle {
  const listeners: {
    data: Array<(d: string) => void>;
    exit: Array<(e: { exitCode: number }) => void>;
  } = { data: [], exit: [] };
  return {
    pid: Math.floor(Math.random() * 10_000) + 1,
    write: () => undefined,
    resize: () => undefined,
    kill: () => {
      for (const listener of listeners.exit) {
        listener({ exitCode: 1 });
      }
    },
    onData: (listener) => {
      listeners.data.push(listener);
    },
    onExit: (listener) => {
      listeners.exit.push(listener);
    },
  };
}

/** 与 handlers 中相同的上限判定（契约锁定）。 */
function assertCapacity(alive: number, max: number): void {
  if (alive >= max) {
    throw new Error(`${WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX} ${max}`);
  }
}

let tempCwd: string;

afterEach(() => {
  if (tempCwd !== undefined) {
    rmSync(tempCwd, { recursive: true, force: true });
  }
});

describe("workbench window limit (main)", () => {
  it("aliveCount 达上限时拒绝新建", () => {
    tempCwd = mkdtempSync(join(tmpdir(), "ffpane-limit-cwd-"));
    mkdirSync(tempCwd, { recursive: true });
    const factory: PtyFactory = () => fakeHandle();
    const manager = new PtyManager({ factory, assignJob: () => undefined });
    const max = 2;
    manager.create({ cwd: tempCwd, cols: 80, rows: 24 });
    manager.create({ cwd: tempCwd, cols: 80, rows: 24 });
    expect(manager.aliveCount()).toBe(2);
    expect(() => assertCapacity(manager.aliveCount(), max)).toThrow(
      `${WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX} 2`,
    );
    expect(isWorkbenchWindowLimitError(`${WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX} 2`)).toBe(true);
  });

  it("killWhere 按 projectId 清场", () => {
    tempCwd = mkdtempSync(join(tmpdir(), "ffpane-limit-cwd-"));
    const factory: PtyFactory = () => fakeHandle();
    const manager = new PtyManager({ factory, assignJob: () => undefined });
    manager.create({
      cwd: tempCwd,
      cols: 80,
      rows: 24,
      metadata: { projectId: "p1" },
    });
    manager.create({
      cwd: tempCwd,
      cols: 80,
      rows: 24,
      metadata: { projectId: "p2" },
    });
    const killed = manager.killWhere((meta) => meta?.["projectId"] === "p1");
    expect(killed).toHaveLength(1);
    expect(manager.aliveCount()).toBe(1);
  });
});
