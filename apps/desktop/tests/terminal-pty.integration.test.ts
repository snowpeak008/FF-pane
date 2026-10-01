/**
 * 真 PTY 集成（可选）：Windows 上 spawn cmd /c echo；非 Windows 或加载失败时 skip。
 *
 * 注意：本文件在 Node（非 Electron ABI）下跑。@lydell/node-pty 以 N-API prebuilds 分发，
 * 与 Electron/Node 共用同一二进制，故此处动态 import 不会因 ABI 崩溃；若平台包缺失则 skip，
 * 不让 vitest 进程因 native 模块硬崩。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MARKER = "ffpane-pty-unit";
const isWindows = process.platform === "win32";

async function probePty(): Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: string }
> {
  try {
    await import(`@lydell/node-pty-${process.platform}-${process.arch}`);
    await import("@lydell/node-pty");
    return { ok: true };
  } catch (thrown) {
    return {
      ok: false,
      reason: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

const probe = await probePty();

describe.skipIf(!isWindows || !probe.ok)("真 PTY 集成（Windows）", () => {
  let cwd = "";

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ffpane-pty-it-"));
  });

  afterEach(() => {
    if (cwd === "") {
      return;
    }
    // cmd 退出后目录句柄还会占一小会儿。重试清的是这个，echo 仍须在 8 秒内出现。
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("spawn cmd /c echo 能拿到输出", async () => {
    const { createNodePtyFactory } = await import("../src/main/terminal/factory");
    const { PtyManager } = await import("../src/main/terminal/manager");
    const manager = new PtyManager({
      factory: createNodePtyFactory(),
      assignJob: () => undefined,
      outputFlushMs: 4,
    });
    try {
      const created = manager.create({
        cwd,
        shell: "cmd.exe",
        args: ["/d", "/s", "/c", `echo ${MARKER}`],
        cols: 80,
        rows: 24,
      });
      const deadline = Date.now() + 8_000;
      let replay = "";
      while (Date.now() < deadline) {
        replay = manager.getReplayBuffer(created.id);
        if (replay.includes(MARKER)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      expect(replay).toContain(MARKER);
    } finally {
      await manager.killAll();
      manager.dispose();
    }
  }, 20_000);
});

describe.skipIf(isWindows && probe.ok)("真 PTY 集成（条件跳过）", () => {
  it("非 Windows 或平台包不可用时跳过真 PTY", () => {
    if (!isWindows) {
      expect(process.platform).not.toBe("win32");
      return;
    }
    expect(probe.ok).toBe(false);
  });
});
