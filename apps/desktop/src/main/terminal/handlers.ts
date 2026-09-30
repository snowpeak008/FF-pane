/**
 * 终端 IPC 装配（T10.1 / T10.2）：create / write / resize / kill / list / replay。
 * T10.2：create 强制校验同时存活窗口上限（读全局 config）。
 */

import { clampMaxWorkbenchWindows, DEFAULT_MAX_WORKBENCH_WINDOWS } from "@ff-pane/shared";
import type { BrowserWindow } from "electron";
import type { InvokeHandlers } from "../../shared-ipc/server";
import { publishEvent } from "../../shared-ipc/server";
import { createNodePtyFactory } from "./factory";
import { PtyManager } from "./manager";
import { assertTerminalCreateIpcSafe, defaultTerminalCwd } from "./shell";

export interface TerminalLayerOptions {
  /** 读取同时窗口上限；缺省回退出厂默认。 */
  readonly getMaxWorkbenchWindows?: () => number | Promise<number>;
}

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

/** 上限拒绝错误前缀（渲染层可据此出友好提示）。 */
export const WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX = "workbench window limit reached:";

export function isWorkbenchWindowLimitError(message: string): boolean {
  return message.startsWith(WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX);
}

/**
 * 创建终端层：推送事件绑定到当前主窗口；cwd 缺省时回退用户主目录。
 */
export function createTerminalLayer(
  getWindow: () => BrowserWindow | null,
  options: TerminalLayerOptions = {},
): TerminalLayer {
  const getMax = options.getMaxWorkbenchWindows ?? (() => DEFAULT_MAX_WORKBENCH_WINDOWS);
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
    "terminal:create": async (request) => {
      assertTerminalCreateIpcSafe(request);
      const max = await getMax();
      const limit = clampMaxWorkbenchWindows(max);
      if (manager.aliveCount() >= limit) {
        throw new Error(`${WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX} ${limit}`);
      }
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
