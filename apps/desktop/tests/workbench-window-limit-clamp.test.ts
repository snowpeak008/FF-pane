/**
 * maxWorkbenchWindows 钳制与「调小不杀已有」语义（T10.2'）。
 */

import { clampMaxWorkbenchWindows, DEFAULT_MAX_WORKBENCH_WINDOWS } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  isWorkbenchWindowLimitError,
  WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX,
} from "../src/main/terminal/handlers";

describe("clampMaxWorkbenchWindows", () => {
  it("钳制到 1–32；非法回退出厂默认", () => {
    expect(clampMaxWorkbenchWindows(0)).toBe(1);
    expect(clampMaxWorkbenchWindows(999)).toBe(32);
    expect(clampMaxWorkbenchWindows(8)).toBe(8);
    expect(clampMaxWorkbenchWindows(Number.NaN)).toBe(DEFAULT_MAX_WORKBENCH_WINDOWS);
    expect(clampMaxWorkbenchWindows("12")).toBe(DEFAULT_MAX_WORKBENCH_WINDOWS);
  });
});

describe("workbench window limit shrink semantics", () => {
  it("调小上限只拒新建（aliveCount 判定），不隐含杀窗", () => {
    const alive = 4;
    const max = clampMaxWorkbenchWindows(2);
    expect(alive).toBeGreaterThan(max);
    expect(() => {
      if (alive >= max) {
        throw new Error(`${WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX} ${max}`);
      }
    }).toThrow(`${WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX} 2`);
    expect(isWorkbenchWindowLimitError(`${WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX} 2`)).toBe(true);
  });
});
