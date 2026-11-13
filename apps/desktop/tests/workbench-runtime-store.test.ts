/**
 * T11.14：运行状态每 3 秒取一次，显示上没变的窗口沿用原来的对象，不让窗口重画。
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  MEMORY_DISPLAY_STEP_BYTES,
  useWorkbenchRuntimeStore,
} from "../src/renderer/src/stores/workbench-runtime";
import type { WorkbenchWindowRuntimeStatus } from "../src/shared-ipc/contracts";

const resources = {
  freeMemoryBytes: 8e9,
  freeDiskBytes: {},
  minFreeMemoryBytes: 0,
  minFreeDiskBytes: 0,
};

function status(workingSetBytes: number): WorkbenchWindowRuntimeStatus {
  return {
    phase: "busy",
    holdingLocks: [],
    waitingLocks: [],
    online: false,
    memory: { processCount: 3, workingSetBytes },
  };
}

function apply(windows: Record<string, WorkbenchWindowRuntimeStatus>): void {
  useWorkbenchRuntimeStore.getState().apply({ windows, resources } as never);
}

describe("useWorkbenchRuntimeStore.apply", () => {
  beforeEach(() => {
    useWorkbenchRuntimeStore.getState().clear();
  });

  it("内存波动没到显示的 0.1GB：沿用原来的对象", () => {
    apply({ a: status(1.2 * 1024 ** 3) });
    const first = useWorkbenchRuntimeStore.getState().windows["a"];
    apply({ a: status(1.2 * 1024 ** 3 + 30 * 1024 ** 2) });
    expect(useWorkbenchRuntimeStore.getState().windows["a"]).toBe(first);
  });

  it("显示的数变了：换新对象，取整到 0.1GB", () => {
    apply({ a: status(1.2 * 1024 ** 3) });
    const first = useWorkbenchRuntimeStore.getState().windows["a"];
    apply({ a: status(1.5 * 1024 ** 3) });
    const next = useWorkbenchRuntimeStore.getState().windows["a"];
    expect(next).not.toBe(first);
    expect((next?.memory?.workingSetBytes ?? 0) / MEMORY_DISPLAY_STEP_BYTES).toBeCloseTo(15);
  });

  it("一个窗口变了，别的窗口对象不变", () => {
    apply({ a: status(1e9), b: status(2e9) });
    const b = useWorkbenchRuntimeStore.getState().windows["b"];
    apply({ a: status(3e9), b: status(2e9) });
    expect(useWorkbenchRuntimeStore.getState().windows["b"]).toBe(b);
  });
});
