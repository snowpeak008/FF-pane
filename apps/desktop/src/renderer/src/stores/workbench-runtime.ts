/**
 * 工作台运行状态：平台看到的窗口状态、持锁等锁，以及本机可用内存和磁盘。
 * 由 WorkbenchRuntimeBar 每 3 秒向主进程取一次，窗口标题栏只读。
 * 内容没变的窗口沿用原来的对象，免得每次轮询都让所有窗口（连同终端）重新渲染。
 */

import { create } from "zustand";
import type {
  WorkbenchRuntimeStatusResponse,
  WorkbenchWindowRuntimeStatus,
} from "../../../shared-ipc/contracts";

/** 标题栏只在忙且这么久没输出时才提示，低于它的静默秒数不用存。 */
export const QUIET_NOTICE_SECONDS = 120;

export interface WorkbenchRuntimeState {
  readonly windows: Readonly<Record<string, WorkbenchWindowRuntimeStatus>>;
  readonly resources: WorkbenchRuntimeStatusResponse["resources"] | null;
  readonly apply: (next: WorkbenchRuntimeStatusResponse) => void;
  readonly clear: () => void;
}

/** 只留标题栏用得到的内容：静默不到提示线时去掉，内存按 10MB 取整。 */
function forDisplay(status: WorkbenchWindowRuntimeStatus): WorkbenchWindowRuntimeStatus {
  const { quietSeconds, memory, ...rest } = status;
  return {
    ...rest,
    ...(quietSeconds !== undefined &&
    status.phase === "busy" &&
    quietSeconds >= QUIET_NOTICE_SECONDS
      ? { quietSeconds: Math.floor(quietSeconds / 60) * 60 }
      : {}),
    ...(memory !== undefined
      ? {
          memory: {
            processCount: memory.processCount,
            workingSetBytes:
              Math.round(memory.workingSetBytes / (10 * 1024 * 1024)) * 10 * 1024 * 1024,
          },
        }
      : {}),
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const useWorkbenchRuntimeStore = create<WorkbenchRuntimeState>((set, get) => ({
  windows: {},
  resources: null,
  apply: (next) => {
    const previous = get();
    const windows: Record<string, WorkbenchWindowRuntimeStatus> = {};
    let changed = Object.keys(previous.windows).length !== Object.keys(next.windows).length;
    for (const [windowId, status] of Object.entries(next.windows)) {
      const shown = forDisplay(status);
      const before = previous.windows[windowId];
      if (before !== undefined && sameJson(before, shown)) {
        windows[windowId] = before;
      } else {
        windows[windowId] = shown;
        changed = true;
      }
    }
    const resources = sameJson(previous.resources, next.resources)
      ? previous.resources
      : next.resources;
    if (!changed && resources === previous.resources) {
      return;
    }
    set({ windows: changed ? windows : previous.windows, resources });
  },
  clear: () => {
    set({ windows: {}, resources: null });
  },
}));
