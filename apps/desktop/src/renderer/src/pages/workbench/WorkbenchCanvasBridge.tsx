/**
 * 画板的全局监听，与 WorkbenchPanelBridge 同层。
 * AI 出图、交图只更新画板按钮上的待检查数，不打开画板、不切页面（T11.0d / T11.0c，Tony 2026-10-27）。
 */

import { type ReactElement, useEffect } from "react";
import { useSubscription } from "../../ipc/useSubscription";
import { useWorkbenchCanvasStore } from "../../stores/workbench-canvas";

export function WorkbenchCanvasBridge(): ReactElement | null {
  useSubscription("workbench:canvas-pending", (payload) => {
    useWorkbenchCanvasStore.getState().setPending(payload.projectId, payload.pending);
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const state = useWorkbenchCanvasStore.getState();
      // 大图开着时 Esc 由画板自己关大图。
      if (event.key !== "Escape" || !state.open || state.viewerOpen) {
        return;
      }
      useWorkbenchCanvasStore.getState().closeCanvas();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return null;
}
