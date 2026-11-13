/**
 * T11.14：界面每分钟清掉攒下的性能记录（开发版 React 每渲染一次记一条、从不清理）。
 */

import { describe, expect, it } from "vitest";
import { clearPerformanceEntries } from "../src/renderer/src/pages/workbench/terminal-webgl";

describe("clearPerformanceEntries", () => {
  it("清掉 measure 和 mark，返回清了几条", () => {
    const entries = { measure: 3, mark: 2 };
    const perf = {
      getEntriesByType: (type: string) => new Array(entries[type as "measure" | "mark"] ?? 0),
      clearMeasures: () => {
        entries.measure = 0;
      },
      clearMarks: () => {
        entries.mark = 0;
      },
    } as unknown as Parameters<typeof clearPerformanceEntries>[0];
    expect(clearPerformanceEntries(perf)).toBe(5);
    expect(entries).toEqual({ measure: 0, mark: 0 });
    expect(clearPerformanceEntries(perf)).toBe(0);
  });

  it("真的 performance：清完一条不剩", () => {
    performance.mark("a");
    performance.measure("b", { start: 0, end: 1 });
    expect(clearPerformanceEntries(performance)).toBeGreaterThanOrEqual(2);
    expect(performance.getEntriesByType("measure")).toHaveLength(0);
    expect(performance.getEntriesByType("mark")).toHaveLength(0);
  });
});
