/**
 * 项目画板：隐藏全屏层，只由用户点按钮打开（T11.0d 起 AI 出图不再自动打开）。
 * unseen：画板关着时 AI 放进来的新图数，按项目记，显示在画板按钮上。
 */

import { create } from "zustand";

export interface WorkbenchCanvasState {
  readonly open: boolean;
  readonly focusPath: string | null;
  readonly unseen: Readonly<Record<string, number>>;
  readonly openCanvas: (focusPath?: string | null) => void;
  readonly closeCanvas: () => void;
  readonly setFocusPath: (path: string | null) => void;
  readonly setUnseen: (projectId: string, count: number) => void;
}

export const useWorkbenchCanvasStore = create<WorkbenchCanvasState>((set) => ({
  open: false,
  focusPath: null,
  unseen: {},
  openCanvas: (focusPath) => {
    set({ open: true, focusPath: focusPath ?? null });
  },
  closeCanvas: () => {
    set({ open: false });
  },
  setFocusPath: (path) => {
    set({ focusPath: path });
  },
  setUnseen: (projectId, count) => {
    set((state) =>
      (state.unseen[projectId] ?? 0) === count
        ? state
        : { unseen: { ...state.unseen, [projectId]: count } },
    );
  },
}));
