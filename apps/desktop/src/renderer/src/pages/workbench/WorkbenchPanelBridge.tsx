/**
 * 隐藏面板的呼出：MCP open_panel 与命令面板。挂在命令面板 Provider 内，任何页面都生效。
 */

import { type ReactElement, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { WorkbenchPanelId } from "../../../../shared-ipc/contracts";
import { useCommandHandler } from "../../command";
import { useSubscription } from "../../ipc/useSubscription";
import { useUiStore } from "../../stores/ui";
import { useWorkbenchPanelStore } from "../../stores/workbench-panel";

export function WorkbenchPanelBridge(): ReactElement | null {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const openFromHere = (tab: WorkbenchPanelId): void => {
    const projectId = useUiStore.getState().activeProjectId;
    if (projectId === null) {
      toast.error(t("workbench.drawer.noProject"));
      navigate("/projects");
      return;
    }
    navigate("/workbench");
    useWorkbenchPanelStore.getState().openPanel(tab);
  };

  useCommandHandler("workbench-open-plan", () => {
    openFromHere("plan");
  });
  useCommandHandler("workbench-open-tasks", () => {
    openFromHere("tasks");
  });
  useCommandHandler("workbench-open-runs", () => {
    openFromHere("runs");
  });

  useSubscription("workbench:open-panel", (payload) => {
    useUiStore.getState().setActiveProjectId(payload.projectId);
    navigate("/workbench");
    useWorkbenchPanelStore.getState().openPanel(payload.panel);
    toast.message(t("workbench.panel.openedBy", { title: payload.openerTitle }));
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !useWorkbenchPanelStore.getState().open) {
        return;
      }
      useWorkbenchPanelStore.getState().closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return null;
}
