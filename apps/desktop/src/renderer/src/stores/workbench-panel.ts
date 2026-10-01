/**
 * 工作台隐藏抽屉的开关。没有常驻按钮，只由 MCP 事件和命令面板写入。
 */

import { create } from "zustand";
import type { WorkbenchPanelId } from "../../../shared-ipc/contracts";

export interface WorkbenchPanelState {
  readonly open: boolean;
  readonly tab: WorkbenchPanelId;
  readonly briefName: string | null;
  readonly openPanel: (tab: WorkbenchPanelId, briefName?: string | null) => void;
  readonly closePanel: () => void;
  readonly selectBrief: (name: string | null) => void;
}

export const useWorkbenchPanelStore = create<WorkbenchPanelState>((set) => ({
  open: false,
  tab: "tasks",
  briefName: null,
  openPanel: (tab, briefName) => {
    set((state) => ({
      open: true,
      tab,
      briefName: briefName === undefined ? state.briefName : briefName,
    }));
  },
  closePanel: () => {
    set({ open: false });
  },
  selectBrief: (briefName) => {
    set({ open: true, tab: "plan", briefName });
  },
}));
