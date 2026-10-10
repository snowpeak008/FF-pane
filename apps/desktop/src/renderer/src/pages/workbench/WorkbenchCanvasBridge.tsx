/**
 * 画板呼出：MCP ffpane_open_canvas 事件。与 WorkbenchPanelBridge 同层。
 */

import { type ReactElement, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useSubscription } from "../../ipc/useSubscription";
import { useUiStore } from "../../stores/ui";
import { useWorkbenchCanvasStore } from "../../stores/workbench-canvas";

export function WorkbenchCanvasBridge(): ReactElement | null {
  const navigate = useNavigate();
  const { t } = useTranslation();

  useSubscription("workbench:open-canvas", (payload) => {
    useUiStore.getState().setActiveProjectId(payload.projectId);
    navigate("/workbench");
    useWorkbenchCanvasStore.getState().openCanvas(payload.focusPath ?? null);
    toast.message(t("workbench.canvas.openedBy", { title: payload.openerTitle }));
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
