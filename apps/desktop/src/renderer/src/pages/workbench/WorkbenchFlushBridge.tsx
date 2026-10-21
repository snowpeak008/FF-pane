/**
 * 工作台布局 flush 桥（T10.2'）：响应主进程退出前请求，并在 pagehide/beforeunload 兜底落盘。
 */

import { type ReactElement, useEffect } from "react";
import { invokeQuery } from "../../ipc/query";
import { useSubscription } from "../../ipc/useSubscription";
import { flushWorkbenchLayouts, useWorkbenchStore } from "../../stores/workbench";
import { rememberLiveTerminal } from "./live-terminals";

export function WorkbenchFlushBridge(): ReactElement | null {
  useSubscription("workbench:window-closed", (payload) => {
    useWorkbenchStore.getState().acceptClosedWindow(payload.projectId, payload.windowId);
  });

  useSubscription("workbench:manager-grant", (payload) => {
    useWorkbenchStore.getState().patchWindow(payload.projectId, payload.windowId, {
      managerGrantPending: payload.managerGrantPending,
    });
  });

  useSubscription("workbench:child-window", (payload) => {
    if (payload.window.terminalId !== undefined) {
      rememberLiveTerminal(payload.window.id, payload.window.terminalId);
    }
    useWorkbenchStore.getState().acceptOpenedWindow(payload);
  });

  // 平台自己重启了窗口（改模型等）。窗口不在当前标签页时也要记上，下次显示时接新终端。
  useSubscription("workbench:terminal-replaced", (payload) => {
    rememberLiveTerminal(payload.windowId, payload.terminalId);
    const store = useWorkbenchStore.getState();
    store.patchWindow(payload.projectId, payload.windowId, { terminalId: payload.terminalId });
    store.patchWindow(payload.projectId, payload.windowId, { routeSnapshot: payload.route });
    if (!payload.resumed) {
      store.clearWindowSessionId(payload.projectId, payload.windowId);
    }
    if (payload.nativeSessionId !== undefined) {
      store.noteWindowSession(payload.projectId, payload.windowId, payload.nativeSessionId);
    }
    if (payload.permissionCapped) {
      store.setWindowPermission(payload.projectId, payload.windowId, payload.effectivePermission);
    }
  });

  useSubscription("workbench:inbox-notice", (payload) => {
    useWorkbenchStore.getState().applyInboxNotice(payload);
  });

  useSubscription("workbench:flush-request", (payload) => {
    void flushWorkbenchLayouts().finally(() => {
      void invokeQuery("workbench:flush-ack", { requestId: payload.requestId });
    });
  });

  useEffect(() => {
    const onLeave = (): void => {
      void flushWorkbenchLayouts();
    };
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, []);

  return null;
}
