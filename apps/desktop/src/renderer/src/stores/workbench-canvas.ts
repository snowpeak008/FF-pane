/**
 * 项目画板：隐藏全屏层，只由用户点按钮打开（T11.0d 起 AI 出图不再自动打开）。
 * pending：每个项目的待检查数（T11.0c），显示在画板按钮上，跟着主进程推的 workbench:canvas-pending 变。
 * viewerOpen：大图开着时 Esc 先关大图，不关画板。
 */

import { create } from "zustand";

export interface WorkbenchCanvasState {
  readonly open: boolean;
  readonly focusPath: string | null;
  readonly pending: Readonly<Record<string, number>>;
  readonly viewerOpen: boolean;
  readonly openCanvas: (focusPath?: string | null) => void;
  readonly closeCanvas: () => void;
  readonly setFocusPath: (path: string | null) => void;
  readonly setPending: (projectId: string, count: number) => void;
  readonly setViewerOpen: (open: boolean) => void;
}

export const useWorkbenchCanvasStore = create<WorkbenchCanvasState>((set) => ({
  open: false,
  focusPath: null,
  pending: {},
  viewerOpen: false,
  openCanvas: (focusPath) => {
    set({ open: true, focusPath: focusPath ?? null });
  },
  closeCanvas: () => {
    set({ open: false, viewerOpen: false });
  },
  setFocusPath: (path) => {
    set({ focusPath: path });
  },
  setPending: (projectId, count) => {
    set((state) =>
      state.pending[projectId] === count
        ? state
        : { pending: { ...state.pending, [projectId]: count } },
    );
  },
  setViewerOpen: (open) => {
    set((state) => (state.viewerOpen === open ? state : { viewerOpen: open }));
  },
}));
