/**
 * 生产用 PTY 工厂：包装 @lydell/node-pty（Windows N-API prebuilds，免 electron-rebuild）。
 *
 * Windows 上 spawn 返回时进程还没创建：node-pty 等 conpty 输出管道就绪后，才在
 * WindowsPtyAgent._completePtyConnection 里同步调用 conptyNative.connect 创建进程。
 * 等 pid 再圈禁，中间这几十毫秒里进程可能已经起了子进程（Git Bash 的 bin\bash.exe 起真 bash、
 * claude.cmd 起 node），子进程就不在 Job 里，关窗收不走（2026-10-20 实测 6 次 1 次）。
 * 所以包住这个方法：connect 一返回、新进程还没执行代码，就同步通知 pid。
 * 依赖 1.2.0-beta.15 的内部结构（版本已锁死）；结构不对时 onPid 返回 false，管理器退回等 pid 并记日志。
 *
 * T11.19：node-pty 给每个终端开一个 worker_threads 工作线程读输出（约 11MB），终端结束后不收：
 * conpty.dll 模式下 CLI 自己退出时什么都不做，kill() 要再来一次输出才收，系统 conpty 模式
 * CLI 自己退出也不收。主进程跑 35 小时漏了 51 个、约 560MB（2026-11-20）。上游到 1.2.0-beta.18
 * 和 main（2026-11-02）都没修（microsoft/node-pty#887 未关）。这里在退出事件送到后自己收。
 */

import { spawn } from "@lydell/node-pty";
import type { PtyFactory, PtyFactoryOptions, PtyHandle } from "./types";

/** 退出事件送到后再等这么久才收工作线程：node-pty 自己冲刷输出等 1 秒，留余量。 */
export const CONOUT_RELEASE_AFTER_EXIT_MS = 2_000;
/** kill() 以后退出事件这么久还没来，也收。 */
export const CONOUT_RELEASE_KILL_WAIT_MS = 5_000;

interface ConoutWorkerLike {
  terminate(): unknown;
  once?(event: "exit", listener: () => void): unknown;
}

/** 终端输出工作线程：开过几个、已经结束几个（不论谁结束的）。[memory] 日志用。 */
const conoutWorkerCounts = { opened: 0, released: 0 };
/** 还没收的，退出软件时一起收。 */
const pendingReleasers = new Set<ConoutWorkerReleaser>();
let unrecognizedLogged = false;

export function conoutWorkerStats(): { readonly opened: number; readonly released: number } {
  return { ...conoutWorkerCounts };
}

/** 退出软件时调：不等那 2 秒，剩下的直接收。 */
export function releaseAllConoutWorkers(): void {
  for (const releaser of [...pendingReleasers]) {
    releaser.releaseNow();
  }
}

export interface ConoutWorkerReleaser {
  /** 退出事件送到了：再等 CONOUT_RELEASE_AFTER_EXIT_MS 收。 */
  exitDelivered(): void;
  /** 本软件 kill 了它：等退出事件；CONOUT_RELEASE_KILL_WAIT_MS 内没来也收。 */
  killed(): void;
  /** 马上收。只收一次，之后再调什么都不做。 */
  releaseNow(): void;
}

/**
 * 从 pty._agent._conoutSocketWorker._worker 取工作线程。认不出结构时记一次日志，之后什么都不做。
 */
export function createConoutWorkerReleaser(pty: unknown): ConoutWorkerReleaser {
  const worker = (
    pty as { readonly _agent?: { readonly _conoutSocketWorker?: { readonly _worker?: unknown } } }
  )?._agent?._conoutSocketWorker?._worker as ConoutWorkerLike | undefined;
  const recognized = typeof worker?.terminate === "function";
  if (!recognized) {
    // 只有 Windows 版 node-pty 有这个工作线程
    if (!unrecognizedLogged && process.platform === "win32") {
      unrecognizedLogged = true;
      console.error(
        "[terminal] node-pty conout worker not found; exited terminals keep their thread",
      );
    }
  } else {
    conoutWorkerCounts.opened += 1;
    worker?.once?.("exit", () => {
      conoutWorkerCounts.released += 1;
    });
  }
  let done = !recognized;
  let exited = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => releaser.releaseNow(), ms);
    timer.unref?.();
  };
  const releaser: ConoutWorkerReleaser = {
    exitDelivered() {
      if (done || exited) {
        return;
      }
      exited = true;
      schedule(CONOUT_RELEASE_AFTER_EXIT_MS);
    },
    killed() {
      if (done || exited) {
        return;
      }
      schedule(CONOUT_RELEASE_KILL_WAIT_MS);
    },
    releaseNow() {
      if (done) {
        return;
      }
      done = true;
      pendingReleasers.delete(releaser);
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      try {
        // 已经被 node-pty 自己收过的，再 terminate 也只是返回一个完成的 Promise。
        Promise.resolve(worker?.terminate()).catch(() => undefined);
      } catch (error) {
        console.error("[terminal] conout worker terminate failed", error);
      }
    },
  };
  if (recognized) {
    pendingReleasers.add(releaser);
  }
  return releaser;
}

/**
 * Windows 上用 node-pty 自带的 conpty.dll + OpenConsole.exe（1.25），不用系统里的 conhost。
 * 系统自带的（Win11 22621 这一代）会把输出重新排版再发出来：光标藏着时不转发光标移动，
 * Claude Code 移到输入处的真光标丢了，停在右下角或刚刷新的状态行，输入法的拼音和候选框跟着乱跳；
 * 同步刷新（?2026）被拆成空帧，行列没变的调尺寸也整屏重画。自带的新版原样转发，三处都没有
 * （2026-10-20 同一个 Claude 实录对比）。起不来时退回系统自带的，并记日志。
 */
const USE_BUNDLED_CONPTY = process.platform === "win32";

export function createNodePtyFactory(): PtyFactory {
  let bundledConptyFailed = false;
  return (options: PtyFactoryOptions): PtyHandle => {
    const spawnWith = (useConptyDll: boolean) =>
      spawn(options.file, typeof options.args === "string" ? options.args : [...options.args], {
        name: options.name,
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
        ...(useConptyDll ? { useConptyDll: true } : {}),
      });
    let pty: ReturnType<typeof spawn>;
    if (USE_BUNDLED_CONPTY && !bundledConptyFailed) {
      try {
        pty = spawnWith(true);
      } catch (error) {
        bundledConptyFailed = true;
        console.error("[terminal] bundled conpty failed, falling back to system conpty", error);
        pty = spawnWith(false);
      }
    } else {
      pty = spawnWith(false);
    }
    const conout = createConoutWorkerReleaser(pty);
    // 自己先订一个：业务代码不订 onExit 也照样收。
    pty.onExit(() => conout.exitDelivered());
    const pidListeners: ((pid: number) => void)[] = [];
    const agent = (
      pty as unknown as {
        readonly _agent?: {
          _completePtyConnection?: () => void;
          readonly innerPid?: number;
          /** _$onProcessExit 收到原生回调时写入；连不上时 node-pty 自己写 -1。 */
          readonly _exitCode?: number;
        };
      }
    )._agent;
    const original = agent?._completePtyConnection;
    const hooked = agent !== undefined && typeof original === "function";
    /** conptyNative.connect 调成功了：之后一定会有一次「进程退出」原生回调。 */
    let connected = false;
    if (hooked) {
      agent._completePtyConnection = () => {
        original.call(agent);
        const pid = agent.innerPid ?? 0;
        connected = pid > 0;
        if (pid > 0) {
          for (const listener of pidListeners.splice(0)) {
            listener(pid);
          }
        }
      };
    }
    return {
      get pid(): number {
        return pty.pid;
      },
      onPid(listener): boolean {
        if (pty.pid > 0) {
          listener(pty.pid);
          return true;
        }
        if (!hooked) {
          return false;
        }
        pidListeners.push(listener);
        return true;
      },
      write(data: string): void {
        pty.write(data);
      },
      resize(cols: number, rows: number): void {
        pty.resize(cols, rows);
      },
      kill(): void {
        pty.kill();
        conout.killed();
      },
      exitDelivered(): boolean {
        // 认不出内部结构就当已送到，不卡退出。
        if (!hooked || !connected) {
          return true;
        }
        return agent?._exitCode !== undefined;
      },
      onData(listener): void {
        pty.onData(listener);
      },
      onExit(listener): void {
        pty.onExit((event) => {
          listener({
            exitCode: event.exitCode,
            ...(event.signal === undefined ? {} : { signal: event.signal }),
          });
        });
      },
    };
  };
}
