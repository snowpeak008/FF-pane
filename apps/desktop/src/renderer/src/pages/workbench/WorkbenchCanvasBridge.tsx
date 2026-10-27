/**
 * 画板的全局监听，与 WorkbenchPanelBridge 同层。
 * AI 出图、交图只更新画板按钮上的新图数，不打开画板、不切页面（T11.0d，Tony 2026-10-27）。
 */

import { type ReactElement, useEffect } from "react";
import { useSubscription } from "../../ipc/useSubscription";
import { useWorkbenchCanvasStore } from "../../stores/workbench-canvas";

export function WorkbenchCanvasBridge(): ReactElement | null {
  useSubscription("workbench:canvas-changed", (payload) => {
    if (payload.unseen !== undefined) {
      useWorkbenchCanvasStore.getState().setUnseen(payload.projectId, payload.unseen);
    }
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !useWorkbenchCanvasStore.getState().open) {
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
