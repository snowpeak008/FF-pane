/**
 * 生产用 PTY 工厂：包装 @lydell/node-pty（Windows N-API prebuilds，免 electron-rebuild）。
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
    return {
      get pid(): number {
        return pty.pid;
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
