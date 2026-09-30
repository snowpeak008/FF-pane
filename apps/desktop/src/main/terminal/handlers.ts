/**
 * 终端 IPC 装配（T10.1）：create / write / resize / kill / list / replay + 输出与退出推送。
 * renderer 不得经 IPC 传入 args / env（由主进程内部 API 保留，供 T10.4）。
 */

import type { BrowserWindow } from "electron";
import type { InvokeHandlers } from "../../shared-ipc/server";
import { publishEvent } from "../../shared-ipc/server";
import { createNodePtyFactory } from "./factory";
import { PtyManager } from "./manager";
import { assertTerminalCreateIpcSafe, defaultTerminalCwd } from "./shell";

export interface TerminalLayer {
  readonly handlers: Pick<
    InvokeHandlers,
    | "terminal:create"
    | "terminal:write"
    | "terminal:resize"
    | "terminal:kill"
    | "terminal:list"
    | "terminal:get-replay"
  >;
  readonly manager: PtyManager;
  readonly dispose: () => Promise<void>;
}

/**
 * 创建终端层：推送事件绑定到当前主窗口；cwd 缺省时回退用户主目录。
 */
export function createTerminalLayer(getWindow: () => BrowserWindow | null): TerminalLayer {
  const manager = new PtyManager({
    factory: createNodePtyFactory(),
    listeners: {
      onOutputBatch: (batch) => {
        const window = getWindow();
        if (window === null || window.isDestroyed()) {
          return;
        }
        publishEvent(window.webContents, "terminal:output", batch);
      },
      onExit: (notice) => {
        const window = getWindow();
        if (window === null || window.isDestroyed()) {
          return;
        }
        publishEvent(window.webContents, "terminal:exit", notice);
      },
    },
  });

  const handlers: TerminalLayer["handlers"] = {
    "terminal:create": (request) => {
      assertTerminalCreateIpcSafe(request);
      const cwd =
        request.cwd === undefined || request.cwd.trim() === "" ? defaultTerminalCwd() : request.cwd;
      return manager.create({
        ...(request.id === undefined ? {} : { id: request.id }),
        cwd,
        ...(request.shell === undefined ? {} : { shell: request.shell }),
        cols: request.cols,
        rows: request.rows,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      });
    },
    "terminal:write": (request) => {
      manager.write(request.id, request.data);
      return { ok: true as const };
    },
    "terminal:resize": (request) => {
      manager.resize(request.id, request.cols, request.rows);
      return { ok: true as const };
    },
    "terminal:kill": (request) => {
      manager.kill(request.id);
      return { ok: true as const };
    },
    "terminal:list": () => manager.list(),
    "terminal:get-replay": (request) => ({
      id: request.id,
      data: manager.getReplayBuffer(request.id),
    }),
  };

  return {
    handlers,
    manager,
    dispose: async () => {
      await manager.killAll();
      manager.dispose();
    },
  };
}
