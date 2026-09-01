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
 * **本层的固有局限（T8.2 已在上层根治，这里如实留档）**：`/T` 遍历的是**当下的
 * 父子表**。若中间进程在被杀之前自己先退出，它的子进程会被系统重父化，此刻已不在
 * 我们这棵树上，`/T` 找不到它（taskkill 报 128「目标不存在」），孤儿继续跑。
 *
 * 一处归因更正（T8.2 实测）：此前这里与 docs/adapters/claude-code.md §5 都把它记成
 * 「msys（git-bash）的进程模型断父子链」。四变体对照实测表明**与 msys 无关**——
 * 纯原生 node → node、中间层先退出，同样逃逸；而 bash → sleep 只要中间层还活着就
 * 杀得干净。msys 只是碰巧常触发「中间层先退出」这个形态。
 *
 * 根治手段是 Windows Job Object（见 job-object.ts）：它按 Job 归属下手而不看父子表，
 * spawn.ts 已在 spawn 之后立即圈禁。本层仍照常保留并被调用：Job 不可用时它是唯一手段，
 * 且覆盖「进程显式 breakaway 出 Job」这类理论漏网。
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
