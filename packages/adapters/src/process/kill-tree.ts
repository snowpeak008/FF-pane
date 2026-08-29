/**
 * 进程树终止（W2.1a）。
 *
 * 为什么必须整树杀（T2.0 实测）：
 * - Codex：launcher → 实际 codex → 命令子进程，实测 4 层（docs/adapters/codex.md §4）；
 * - OpenCode：npm wrapper 报告的 PID ≠ 实际监听进程，杀 wrapper 无效
 *   （docs/adapters/opencode.md §1、§8.2 坑 3）；
 * - Gemini CLI：非 TTY 下无任何取消协议，唯一手段是杀树（gemini-cli.md §5）；
 * - 本层还会多一层 cmd.exe 垫片（见 windows-command.ts），单杀句柄必然漏。
 *
 * 已知残留（记录在案，非本层可解）：Claude Code 在 Windows 用 git-bash 执行
 * Bash 工具，msys 的孙进程不在可枚举进程树上，`taskkill /T` 之后仍可能成为
 * 孤儿（docs/adapters/claude-code.md §5）。适配器应优先走 interrupt 协议，
 * 硬杀只作兜底。彻底解决需要 Windows Job Object，超出本工单范围。
 */

/// <reference types="node" />

import { spawn } from "node:child_process";
import process from "node:process";

/** taskkill 报告"没有找到进程"的退出码（本机实测 128）。 */
export const TASKKILL_PROCESS_NOT_FOUND_EXIT_CODE = 128;

/** 一次树杀的结果。用于日志与"是否需要升级手段"的判断，不代表目标一定已退出。 */
export interface KillTreeOutcome {
  /** Windows 走 taskkill /T /F；其余平台走进程组信号。 */
  readonly method: "taskkill" | "signal";
  /** taskkill 的退出码（signal 方式为 null）。 */
  readonly exitCode: number | null;
  /** 目标进程当时已不存在（taskkill 128 / ESRCH），kill 幂等的判定依据。 */
  readonly alreadyGone: boolean;
  readonly error: string | null;
}

function outcome(partial: Partial<KillTreeOutcome> & { method: KillTreeOutcome["method"] }) {
  return {
    exitCode: null,
    alreadyGone: false,
    error: null,
    ...partial,
  } satisfies KillTreeOutcome;
}

/** Windows：spawn taskkill /PID <pid> /T /F 并收集退出码。 */
function killTreeWithTaskkill(pid: number): Promise<KillTreeOutcome> {
  return new Promise<KillTreeOutcome>((resolve) => {
    const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once("error", (error: NodeJS.ErrnoException) => {
      // taskkill 不可用（极端裁剪的系统）：退回直接信号，至少杀掉主进程。
      resolve({
        ...killWithSignal(pid),
        error: `taskkill 不可用（${error.code ?? error.message}），已退回直接信号`,
      });
    });
    taskkill.once("close", (code) => {
      const alreadyGone = code === TASKKILL_PROCESS_NOT_FOUND_EXIT_CODE;
      resolve(
        outcome({
          method: "taskkill",
          exitCode: code,
          alreadyGone,
          error: code === 0 || alreadyGone ? null : `taskkill 退出码 ${String(code)}`,
        }),
      );
    });
  });
}

/**
 * 非 Windows：先杀进程组（本层 spawn 时对非 Windows 平台开 detached，
 * 子进程即组长），组不存在再退回单进程。
 */
function killWithSignal(pid: number): KillTreeOutcome {
  try {
    process.kill(-pid, "SIGKILL");
    return outcome({ method: "signal" });
  } catch (groupError) {
    const groupCode = (groupError as NodeJS.ErrnoException).code;
    try {
      process.kill(pid, "SIGKILL");
      return outcome({ method: "signal" });
    } catch (singleError) {
      const code = (singleError as NodeJS.ErrnoException).code;
      return outcome({
        method: "signal",
        alreadyGone: code === "ESRCH",
        error: code === "ESRCH" ? null : `${groupCode ?? "?"} / ${code ?? "?"}`,
      });
    }
  }
}

/**
 * 终止 pid 所在的整棵进程树。已退出的 pid 调用无害（alreadyGone: true）。
 *
 * 注意：本函数只负责"下手"，不承诺目标已消失——确认退出应以进程句柄的
 * exit/close 事件为准（spawnAgentProcess 的 kill() 已经这么做）。
 */
export function killProcessTree(pid: number): Promise<KillTreeOutcome> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve(
      outcome({
        method: process.platform === "win32" ? "taskkill" : "signal",
        alreadyGone: true,
        error: `无效 pid：${String(pid)}`,
      }),
    );
  }
  if (process.platform === "win32") {
    return killTreeWithTaskkill(pid);
  }
  return Promise.resolve(killWithSignal(pid));
}
