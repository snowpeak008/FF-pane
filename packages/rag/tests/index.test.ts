import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, rrfScore } from "../src/index.js";

describe("@ff-pane/rag", () => {
  it("导出正确的包名常量", () => {
    expect(PACKAGE_NAME).toBe("@ff-pane/rag");
  });

  it("rrfScore 按 1/(k+rank) 计算且随排名递减", () => {
    expect(rrfScore(1)).toBeCloseTo(1 / 61);
    expect(rrfScore(2)).toBeCloseTo(1 / 62);
    expect(rrfScore(1, 10)).toBeCloseTo(1 / 11);
    expect(rrfScore(1)).toBeGreaterThan(rrfScore(2));
  });

  it("rrfScore 拒绝非法入参", () => {
    expect(() => rrfScore(0)).toThrow(RangeError);
    expect(() => rrfScore(1.5)).toThrow(RangeError);
    expect(() => rrfScore(1, 0)).toThrow(RangeError);
  });
});
