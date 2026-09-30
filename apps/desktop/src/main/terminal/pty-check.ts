/**
 * 启动期 / --smoke 模式下的 PTY 加载自检：spawn 默认 shell（或 cmd）执行简单命令并确认拿到输出。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { PtyCheckReport } from "../../shared-ipc/contracts";
import { createNodePtyFactory } from "./factory";
import { PtyManager } from "./manager";
import { resolveDefaultShell } from "./shell";

const CHECK_MARKER = "ffpane-pty-ok";
const CHECK_TIMEOUT_MS = 8_000;

/**
 * 打开一个短命 PTY，执行 echo 标记并等待输出出现。
 * 失败时抛出带修复提示的错误（与 sqlite-check 同款呈现约定）。
 */
export async function runPtyCheck(): Promise<PtyCheckReport> {
  const cwd = mkdtempSync(join(tmpdir(), "ffpane-pty-check-"));
  const manager = new PtyManager({
    factory: createNodePtyFactory(),
    assignJob: () => undefined,
    outputFlushMs: 4,
  });

  try {
    const shell = resolveDefaultShell();
    const isWin = process.platform === "win32";
    // Windows：用 cmd /c 最稳；非 Windows：用 printf 经默认 shell -lc
    const created = isWin
      ? manager.create({
          cwd,
          shell: "cmd.exe",
          args: ["/d", "/s", "/c", `echo ${CHECK_MARKER}`],
          cols: 80,
          rows: 24,
        })
      : manager.create({
          cwd,
          shell,
          args: ["-lc", `printf '%s\\n' ${CHECK_MARKER}`],
          cols: 80,
          rows: 24,
        });

    const deadline = Date.now() + CHECK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const replay = manager.getReplayBuffer(created.id);
      if (replay.includes(CHECK_MARKER)) {
        return {
          shell,
          marker: CHECK_MARKER,
          checkedAt: Date.now(),
        };
      }
      const info = manager.get(created.id);
      if (info?.exited === true && !manager.getReplayBuffer(created.id).includes(CHECK_MARKER)) {
        // 给批量 flush 一帧机会
        await sleep(20);
        if (manager.getReplayBuffer(created.id).includes(CHECK_MARKER)) {
          return {
            shell,
            marker: CHECK_MARKER,
            checkedAt: Date.now(),
          };
        }
        throw new Error(
          `PTY exited (code ${String(info.exitCode)}) before marker appeared; replay=${JSON.stringify(replay)}`,
        );
      }
      await sleep(50);
    }
    throw new Error(
      `PTY check timed out after ${CHECK_TIMEOUT_MS}ms; replay=${JSON.stringify(manager.getReplayBuffer(created.id))}`,
    );
  } catch (thrown) {
    const cause = thrown instanceof Error ? thrown.message : String(thrown);
    throw new Error(
      "node-pty (@lydell/node-pty) load or spawn failed. Confirm node_modules/@lydell/node-pty-*/prebuilds " +
        "contains conpty.node (Windows) for the current platform, and that electron-builder asarUnpack covers it. " +
        `Original error: ${cause}`,
    );
  } finally {
    await manager.killAll();
    manager.dispose();
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
