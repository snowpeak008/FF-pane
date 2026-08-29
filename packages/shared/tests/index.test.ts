import { describe, expect, it } from "vitest";
import { clamp, PACKAGE_NAME } from "../src/index.js";

describe("@ff-pane/shared", () => {
  it("导出正确的包名常量", () => {
    expect(PACKAGE_NAME).toBe("@ff-pane/shared");
  });

  it("clamp 将值收敛到区间内", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it("clamp 在 min > max 时抛出 RangeError", () => {
    expect(() => clamp(1, 10, 0)).toThrow(RangeError);
  });
});
