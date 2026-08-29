/**
 * Agent CLI 子进程 spawn 封装（W2.1a）。
 *
 * 设计要点：
 * - 一切失败都归一为 AgentProcessExit（exitPromise 永不 reject），spawn 层错误
 *   （ENOENT、PATH 未命中、非法参数）落为 kind = "spawn-failed"；
 * - stdout/stderr 以原始块交出（见 stream.ts），行切分归 W2.1b；
 * - 取消 = 进程树终止（见 kill-tree.ts），并以进程句柄的退出事件确认；
 * - 环境变量默认剥离 API key 类变量（见 env.ts），显式注入优先。
 */

/// <reference types="node" />

import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { buildAgentEnv } from "./env.js";
import { killProcessTree } from "./kill-tree.js";
import { ByteChunkQueue, DEFAULT_STREAM_HIGH_WATER_MARK } from "./stream.js";
import type {
  AgentProcessEndKind,
  AgentProcessExit,
  AgentProcessHandle,
  AgentProcessSpec,
} from "./types.js";
import { resolveSpawnTarget } from "./windows-command.js";

/** 树杀后等待主进程句柄退出的确认时限；超时则对句柄直接补一刀。 */
export const KILL_CONFIRM_TIMEOUT_MS = 3_000;

/**
 * 'exit' 之后等 'close'（stdio 关闭）的宽限期。消费方放弃读流、被背压堵住时
 * 'close' 可能永不到来，宽限期到就照样收口，避免 exitPromise 悬着。
 */
export const EXIT_SETTLE_GRACE_MS = 5_000;

/** 子进程先退出时写 stdin 会触发 EPIPE，吞掉以免升级为未捕获的 'error'。 */
function ignoreStreamError(): void {
  return;
}

function describeError(error: NodeJS.ErrnoException): string {
  return error.code === undefined ? error.message : `${error.code}: ${error.message}`;
}

/** 进程根本没起来时的句柄：空流 + 已定局的 exitPromise。 */
function spawnFailedHandle(
  spec: AgentProcessSpec,
  strippedEnvNames: readonly string[],
  error: string,
  errorCode: string | null,
): AgentProcessHandle {
  const exit: AgentProcessExit = {
    kind: "spawn-failed",
    exitCode: null,
    signal: null,
    error,
    errorCode,
  };
  const exitPromise = Promise.resolve(exit);
  return {
    pid: undefined,
    stdout: new ByteChunkQueue(null),
    stderr: new ByteChunkQueue(null),
    stdin: null,
    exitPromise,
    resolvedCommand: spec.command,
    viaCmdShim: false,
    strippedEnvNames,
    kill: () => exitPromise,
  };
}

/**
 * 启动一个 Agent CLI 子进程。
 *
 * 同步返回句柄（pid 立即可用）；spawn 失败不抛异常，而是在 exitPromise 上
 * 给出 kind = "spawn-failed"。调用方须消费 stdout/stderr 两条流，或在不再需要
 * 输出时调用 kill()（流有背压，见 types.ts 对句柄的约定）。
 */
export function spawnAgentProcess(spec: AgentProcessSpec): AgentProcessHandle {
  const args = spec.args ?? [];
  const { env, strippedNames } = buildAgentEnv({
    baseEnv: spec.baseEnv,
    inject: spec.env,
    stripApiKeyEnv: spec.stripApiKeyEnv,
  });
  const highWaterMark = spec.streamHighWaterMark ?? DEFAULT_STREAM_HIGH_WATER_MARK;

  // PATH 解析用清洗+注入后的 env：注入表若覆盖了 PATH，解析必须跟着走。
  const target = resolveSpawnTarget(spec.command, args, env);
  if (target === undefined) {
    return spawnFailedHandle(
      spec,
      strippedNames,
      `ENOENT: PATH × PATHEXT 中找不到可执行文件 ${spec.command}`,
      "ENOENT",
    );
  }

  let child: ChildProcess;
  try {
    child = spawn(target.file, [...target.args], {
      cwd: spec.cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: target.windowsVerbatimArguments,
      stdio: [spec.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
      // 非 Windows：自成进程组，killProcessTree 才能按组杀。
      detached: process.platform !== "win32",
    });
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    return spawnFailedHandle(spec, strippedNames, describeError(errno), errno.code ?? null);
  }

  const stdout = new ByteChunkQueue(child.stdout, highWaterMark);
  const stderr = new ByteChunkQueue(child.stderr, highWaterMark);
  child.stdin?.on("error", ignoreStreamError);

  let exitState: AgentProcessExit | null = null;
  let settleExit!: (exit: AgentProcessExit) => void;
  const exitPromise = new Promise<AgentProcessExit>((resolve) => {
    settleExit = resolve;
  });

  // 进程本体是否已消失。与 exitPromise 分开：exitPromise 要等 stdio 关闭，
  // 而孙进程可能继续占着 stdout（Codex 场景），确认树杀效果只该看进程本体。
  let processGone = false;
  let markProcessGone!: () => void;
  const processGonePromise = new Promise<void>((resolve) => {
    markProcessGone = () => {
      processGone = true;
      resolve();
    };
  });

  let spawnObserved = false;
  let killRequested = false;
  let timedOut = false;
  let lastError: NodeJS.ErrnoException | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let graceTimer: NodeJS.Timeout | null = null;

  function settle(exit: AgentProcessExit): void {
    if (exitState !== null) {
      return;
    }
    exitState = exit;
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    settleExit(exit);
  }

  function buildExit(code: number | null, signal: NodeJS.Signals | null): AgentProcessExit {
    let kind: AgentProcessEndKind;
    if (timedOut) {
      kind = "timeout";
    } else if (killRequested || signal !== null) {
      kind = "killed";
    } else {
      kind = "exited";
    }
    return {
      kind,
      exitCode: code,
      signal,
      error: lastError === null ? null : describeError(lastError),
      errorCode: lastError?.code ?? null,
    };
  }

  /** 进程本体已消失返回 true；否则等到超时返回 false。 */
  async function processGoneWithin(timeoutMs: number): Promise<boolean> {
    if (processGone) {
      return true;
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    const gone = await Promise.race([processGonePromise.then(() => true as const), deadline]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    return gone;
  }

  async function terminate(): Promise<void> {
    if (processGone || exitState !== null || child.pid === undefined) {
      return;
    }
    await killProcessTree(child.pid);
    if (await processGoneWithin(KILL_CONFIRM_TIMEOUT_MS)) {
      return;
    }
    // 树杀后主进程句柄仍未退出（taskkill 被拒等）：对句柄直接补一刀。
    try {
      child.kill("SIGKILL");
    } catch (error) {
      lastError = error as NodeJS.ErrnoException;
    }
  }

  child.once("spawn", () => {
    spawnObserved = true;
  });

  child.once("error", (error: NodeJS.ErrnoException) => {
    lastError = error;
    if (!spawnObserved) {
      markProcessGone();
      settle({
        kind: "spawn-failed",
        exitCode: null,
        signal: null,
        error: describeError(error),
        errorCode: error.code ?? null,
      });
    }
  });

  child.once("exit", (code, signal) => {
    markProcessGone();
    if (exitState !== null) {
      return;
    }
    graceTimer = setTimeout(() => {
      settle(buildExit(code, signal));
    }, EXIT_SETTLE_GRACE_MS);
  });

  // 'close' 在 stdio 全部关闭后触发，此时排队字节已全部进入本层队列。
  child.once("close", (code, signal) => {
    markProcessGone();
    settle(buildExit(code, signal));
  });

  const timeoutMs = spec.timeoutMs ?? 0;
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      if (processGone) {
        // 进程已自然退出、只是 stdio 未关闭（孙进程占着管道）：不该记成 timeout，
        // 交给 'exit' 的宽限期按真实退出码收口。
        return;
      }
      timedOut = true;
      void terminate();
    }, timeoutMs);
  }

  return {
    pid: child.pid,
    stdout,
    stderr,
    stdin: child.stdin ?? null,
    exitPromise,
    resolvedCommand: target.resolvedCommand,
    viaCmdShim: target.viaCmdShim,
    strippedEnvNames: strippedNames,
    kill: async () => {
      killRequested = true;
      await terminate();
      return exitPromise;
    },
  };
}
