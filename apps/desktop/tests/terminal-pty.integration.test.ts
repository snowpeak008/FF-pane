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

  it("光标藏着时移动也原样转发：输入法跟着真光标走，Claude Code 移到输入处的光标不能丢", async () => {
    const { createNodePtyFactory } = await import("../src/main/terminal/factory");
    const { Terminal } = await import("@xterm/headless");
    const script = [
      "process.stdout.write('\\x1b[?25l\\x1b[5;10Hstatus\\x1b[2;3H');",
      "setTimeout(() => {}, 1500);",
    ].join("");
    const handle = createNodePtyFactory()({
      file: process.execPath,
      args: ["-e", script],
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env } as Record<string, string>,
    });
    let output = "";
    handle.onData((data) => {
      output += data;
    });
    const exited = new Promise<void>((resolve) => {
      handle.onExit(() => resolve());
    });
    await exited;
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(output, resolve));
    expect(term.buffer.active.getLine(4)?.translateToString(true)).toContain("status");
    expect([term.buffer.active.cursorY + 1, term.buffer.active.cursorX + 1]).toEqual([2, 3]);
    term.dispose();
  }, 20_000);

  it("真 Job Object：pid 到手后圈禁成功，关窗时 Start-Process 起的后台进程一起结束", async () => {
    const { execSync } = await import("node:child_process");
    const { createNodePtyFactory } = await import("../src/main/terminal/factory");
    const { PtyManager } = await import("../src/main/terminal/manager");
    const marker = `ffpanejobit${Date.now().toString(36)}`;
    const alive = (): boolean =>
      execSync(
        `powershell -NoProfile -Command "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.CommandLine -notlike '*Get-CimInstance*' }).Count"`,
        { encoding: "utf8" },
      ).trim() !== "0";
    const manager = new PtyManager({ factory: createNodePtyFactory(), outputFlushMs: 4 });
    try {
      const created = manager.create({ cwd, shell: "cmd.exe", cols: 80, rows: 24 });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && manager.get(created.id)?.contained !== true) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      expect(manager.get(created.id)?.contained).toBe(true);
      manager.write(
        created.id,
        `powershell -NoProfile -Command "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Start-Sleep 120; ''${marker}'''"\r`,
      );
      const started = Date.now() + 10_000;
      while (Date.now() < started && !alive()) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(alive()).toBe(true);
      // 进程组统计把脱离父子关系的后台进程也算进来：cmd + 后台 powershell 至少 2 个。
      const stats = manager.getStats(created.id);
      expect(stats?.processCount ?? 0).toBeGreaterThanOrEqual(2);
      expect(stats?.workingSetBytes ?? 0).toBeGreaterThan(10 * 1024 * 1024);
      manager.kill(created.id);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(alive()).toBe(false);
    } finally {
      await manager.killAll();
      manager.dispose();
      try {
        execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
        );
      } catch {
        // 清理尽力而为
      }
    }
  }, 40_000);

  it("Git Bash 启动器做根、开新控制台窗口起后台进程：连续 8 次关窗都不留（同步圈禁没有竞态）", async () => {
    const { execSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const { dirname: dir, join: pathJoin } = await import("node:path");
    let gitBash: string | undefined;
    try {
      const gitExe = execSync("where git", { encoding: "utf8" }).split(/\r?\n/)[0]?.trim() ?? "";
      let cursor = dir(gitExe);
      for (let up = 0; up < 4 && gitBash === undefined; up += 1) {
        const candidate = pathJoin(cursor, "bin", "bash.exe");
        if (existsSync(candidate)) {
          gitBash = candidate;
        }
        cursor = dir(cursor);
      }
    } catch {
      gitBash = undefined;
    }
    if (gitBash === undefined) {
      return;
    }
    const { createNodePtyFactory } = await import("../src/main/terminal/factory");
    const { PtyManager } = await import("../src/main/terminal/manager");
    const count = (marker: string): number =>
      Number(
        execSync(
          `powershell -NoProfile -Command "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.CommandLine -notlike '*Get-CimInstance*' }).Count"`,
          { encoding: "utf8" },
        ).trim(),
      );
    // 只数真起来的 powershell：卡在报错框上的 cmd 不算数。
    const shells = (marker: string): number =>
      Number(
        execSync(
          `powershell -NoProfile -Command "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*Start-Sleep 120*' -and $_.CommandLine -like '*${marker}*' -and $_.CommandLine -notlike '*Get-CimInstance*' }).Count"`,
          { encoding: "utf8" },
        ).trim(),
      );
    const manager = new PtyManager({ factory: createNodePtyFactory(), outputFlushMs: 4 });
    const markers: string[] = [];
    try {
      for (let run = 0; run < 8; run += 1) {
        const marker = `ffpanegitbash${run}${Date.now().toString(36)}`;
        markers.push(marker);
        const created = manager.create({
          cwd,
          direct: { file: gitBash, args: ["--login", "-i"] },
          cols: 100,
          rows: 30,
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(manager.get(created.id)?.contained).toBe(true);
        manager.write(
          created.id,
          // 开新控制台窗口的后台进程。不用 cmd 的 start：Git Bash 会把 /min 和转义引号改写成路径，
          // start 打不开就弹「找不到文件」框，后台进程也没起来。
          `powershell -NoProfile -Command "Start-Process -WindowStyle Minimized powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 120; ''${marker}'''"\r`,
        );
        const appear = Date.now() + 10_000;
        while (Date.now() < appear && shells(marker) === 0) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        expect(shells(marker), "新窗口里的 powershell 应当真的起来了").toBeGreaterThan(0);
        manager.kill(created.id);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(count(marker), `第 ${run} 次`).toBe(0);
      }
    } finally {
      await manager.killAll();
      manager.dispose();
      for (const marker of markers) {
        try {
          execSync(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
          );
        } catch {
          // 清理尽力而为
        }
      }
    }
  }, 180_000);
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
