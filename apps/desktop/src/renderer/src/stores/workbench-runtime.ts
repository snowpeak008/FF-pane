/**
 * 工作台运行状态：平台看到的窗口状态、持锁等锁，以及本机可用内存和磁盘。
 * 由 WorkbenchRuntimeBar 定时向主进程取，窗口标题栏只读。
 */

import { create } from "zustand";
import type {
  WorkbenchRuntimeStatusResponse,
  WorkbenchWindowRuntimeStatus,
} from "../../../shared-ipc/contracts";

export interface WorkbenchRuntimeState {
  readonly windows: Readonly<Record<string, WorkbenchWindowRuntimeStatus>>;
  readonly resources: WorkbenchRuntimeStatusResponse["resources"] | null;
  readonly apply: (next: WorkbenchRuntimeStatusResponse) => void;
  readonly clear: () => void;
}

export const useWorkbenchRuntimeStore = create<WorkbenchRuntimeState>((set) => ({
  windows: {},
  resources: null,
  apply: (next) => {
    set({ windows: next.windows, resources: next.resources });
  },
  clear: () => {
    set({ windows: {}, resources: null });
  },
}));
