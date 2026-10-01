/**
 * 退出前向渲染端请求 flush 布局防抖（T10.2'）。
 * 主进程发 workbench:flush-request，等待 workbench:flush-ack 或超时。
 */

import { randomUUID } from "node:crypto";

import type { InvokeHandlers } from "../shared-ipc/server";
import { publishEvent, type WebContentsLike } from "../shared-ipc/server";

/** 退出时等待渲染端落盘的预算。 */
export const WORKBENCH_LAYOUT_FLUSH_BUDGET_MS = 800;

export interface LayoutFlushBridge {
  readonly handlers: Pick<InvokeHandlers, "workbench:flush-ack">;
  /** 向渲染端请求 flush；无窗口时立即完成。 */
  readonly requestFlush: () => Promise<void>;
}

/**
 * 创建布局 flush 桥：挂到 before-quit（经 QuitCoordinator.flushLayouts）与 IPC ack。
 */
export function createLayoutFlushBridge(
  getWebContents: () => WebContentsLike | null,
): LayoutFlushBridge {
  let pending: { readonly requestId: string; readonly resolve: () => void } | null = null;

  return {
    handlers: {
      "workbench:flush-ack": (request) => {
        if (pending !== null && pending.requestId === request.requestId) {
          pending.resolve();
          pending = null;
        }
        return { ok: true as const };
      },
    },

    requestFlush: () => {
      const target = getWebContents();
      if (target === null) {
        return Promise.resolve();
      }
      const requestId = randomUUID();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (pending?.requestId === requestId) {
            pending = null;
          }
          resolve();
        }, WORKBENCH_LAYOUT_FLUSH_BUDGET_MS);
        pending = {
          requestId,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        };
        try {
          publishEvent(target, "workbench:flush-request", { requestId });
        } catch {
          clearTimeout(timer);
          pending = null;
          resolve();
        }
      });
    },
  };
}
