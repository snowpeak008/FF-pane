/**
 * 项目画板：隐藏全屏层，由 MCP ffpane_open_canvas 或命令打开。
 */

import { create } from "zustand";

export interface WorkbenchCanvasState {
  readonly open: boolean;
  readonly focusPath: string | null;
  readonly openCanvas: (focusPath?: string | null) => void;
  readonly closeCanvas: () => void;
  readonly setFocusPath: (path: string | null) => void;
}

export const useWorkbenchCanvasStore = create<WorkbenchCanvasState>((set) => ({
  open: false,
  focusPath: null,
  openCanvas: (focusPath) => {
    set({ open: true, focusPath: focusPath ?? null });
  },
  closeCanvas: () => {
    set({ open: false });
  },
  setFocusPath: (path) => {
    set({ focusPath: path });
  },
}));
