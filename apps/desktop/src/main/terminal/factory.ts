/**
 * 生产用 PTY 工厂：包装 @lydell/node-pty（Windows N-API prebuilds，免 electron-rebuild）。
 *
 * Windows 上 spawn 返回时进程还没创建：node-pty 等 conpty 输出管道就绪后，才在
 * WindowsPtyAgent._completePtyConnection 里同步调用 conptyNative.connect 创建进程。
 * 等 pid 再圈禁，中间这几十毫秒里进程可能已经起了子进程（Git Bash 的 bin\bash.exe 起真 bash、
 * claude.cmd 起 node），子进程就不在 Job 里，关窗收不走（2026-10-20 实测 6 次 1 次）。
 * 所以包住这个方法：connect 一返回、新进程还没执行代码，就同步通知 pid。
 * 依赖 1.2.0-beta.15 的内部结构（版本已锁死）；结构不对时 onPid 返回 false，管理器退回等 pid 并记日志。
 */

import { spawn } from "@lydell/node-pty";
import type { PtyFactory, PtyFactoryOptions, PtyHandle } from "./types";

export function createNodePtyFactory(): PtyFactory {
  return (options: PtyFactoryOptions): PtyHandle => {
    const pty = spawn(
      options.file,
      typeof options.args === "string" ? options.args : [...options.args],
      {
        name: options.name,
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
      },
    );
    const pidListeners: ((pid: number) => void)[] = [];
    const agent = (
      pty as unknown as {
        readonly _agent?: { _completePtyConnection?: () => void; readonly innerPid?: number };
      }
    )._agent;
    const original = agent?._completePtyConnection;
    const hooked = agent !== undefined && typeof original === "function";
    if (hooked) {
      agent._completePtyConnection = () => {
        original.call(agent);
        const pid = agent.innerPid ?? 0;
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
