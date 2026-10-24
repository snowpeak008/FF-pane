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
  /** PTY 退出时回调（含自然退出与 kill）；用于清理窗口级临时文件。 */
  readonly onTerminalExit?: (
    metadata: Readonly<Record<string, unknown>> | undefined,
    terminalId: string,
    exit: { readonly exitCode: number; readonly killed: boolean },
  ) => void;
  /**
   * 用户按键（不含空闲队列自己的 write）。
   * data 含 `\r` 表示这次是提交（Enter）。
   */
  readonly onUserInput?: (terminalId: string, data: string) => void;
  /** 用户开始或结束用输入法选词。 */
  readonly onUserComposing?: (terminalId: string, composing: boolean) => void;
}

export interface TerminalLayer {
  readonly handlers: Pick<
    InvokeHandlers,
    | "terminal:create"
    | "terminal:write"
    | "terminal:composing"
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
 * 界面 xterm 写来的内容：过期或重复的终端应答由闸门丢掉。
 * 终端应答不是用户在打字：不推迟投递，也不当成提交，所以只把剩下的按键交给 onUserInput。
 */
export function writeFromView(
  manager: PtyManager,
  terminalId: string,
  data: string,
  onUserInput: TerminalLayerOptions["onUserInput"],
): void {
  const written = manager.writeFromView(terminalId, data);
  if (written.typed.length > 0) {
    onUserInput?.(terminalId, written.typed);
  }
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
        options.onTerminalExit?.(notice.metadata, notice.id, {
          exitCode: notice.exitCode,
          killed: notice.killed === true,
        });
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
      writeFromView(manager, request.id, request.data, options.onUserInput);
      return { ok: true as const };
    },
    "terminal:composing": (request) => {
      options.onUserComposing?.(request.id, request.composing === true);
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
