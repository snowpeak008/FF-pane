/**
 * 工作台布局 flush 桥（T10.2'）：响应主进程退出前请求，并在 pagehide/beforeunload 兜底落盘。
 */

import { type ReactElement, useEffect } from "react";
import { invokeQuery } from "../../ipc/query";
import { useSubscription } from "../../ipc/useSubscription";
import { flushWorkbenchLayouts } from "../../stores/workbench";

export function WorkbenchFlushBridge(): ReactElement | null {
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
