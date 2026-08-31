/**
 * T6.4 RRF 融合单测（纯函数，不碰 SQLite）。
 * 库那侧的双路召回与过滤在 packages/storage/tests/knowledge-index.test.ts。
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_RRF_K, fuseByRrf, rrfScore } from "../src/index.js";

/** 取融合结果的 ID 序列，断言排序时只关心顺序。 */
function order<T>(hits: readonly { readonly id: T }[]): T[] {
  return hits.map((hit) => hit.id);
}

describe("rrfScore", () => {
  it("名次越靠前得分越高，且与 1/(k+rank) 一致", () => {
    expect(rrfScore(1)).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12);
    expect(rrfScore(1)).toBeGreaterThan(rrfScore(2));
    expect(rrfScore(2, 10)).toBeCloseTo(1 / 12, 12);
  });

  it("非法名次与非法 k 立即抛", () => {
    expect(() => rrfScore(0)).toThrow(RangeError);
    expect(() => rrfScore(1.5)).toThrow(RangeError);
    expect(() => rrfScore(1, 0)).toThrow(RangeError);
  });
});

describe("fuseByRrf", () => {
  it("单路融合就是原顺序", () => {
    const fused = fuseByRrf([{ source: "fts", ids: ["a", "b", "c"] }]);

    expect(order(fused)).toEqual(["a", "b", "c"]);
    expect(fused[0]?.sources).toEqual(["fts"]);
    expect(fused[0]?.ranks).toEqual({ fts: 1 });
  });

  it("两路都命中的项排到只被一路命中的前面（RRF 的核心价值）", () => {
    // b 在两路都是第 2 名，a 只在 fts 第 1 名、c 只在 vector 第 1 名
    const fused = fuseByRrf([
      { source: "fts", ids: ["a", "b"] },
      { source: "vector", ids: ["c", "b"] },
    ]);

    expect(fused[0]?.id).toBe("b");
    expect(fused[0]?.sources).toEqual(["fts", "vector"]);
    expect(fused[0]?.ranks).toEqual({ fts: 2, vector: 2 });
  });

  it("一路的深位命中能被另一路的高位命中救回来", () => {
    // z 在 fts 里排到第 30 名，但向量路第 1 —— 融合后应显著前移
    const ftsIds = Array.from({ length: 30 }, (_, index) => (index === 29 ? "z" : `f${index}`));
    const fused = fuseByRrf([
      { source: "fts", ids: ftsIds },
      { source: "vector", ids: ["z"] },
    ]);

    expect(fused[0]?.id).toBe("z");
  });

  it("weight 为 0 的路整条缺席（未配嵌入模型的表达）", () => {
    const fused = fuseByRrf([
      { source: "fts", ids: ["a", "b"] },
      { source: "vector", ids: ["c"], weight: 0 },
    ]);

    expect(order(fused)).toEqual(["a", "b"]);
    expect(fused.every((hit) => !hit.sources.includes("vector"))).toBe(true);
  });

  it("weight 放大一路的影响", () => {
    const equal = fuseByRrf([
      { source: "fts", ids: ["a"] },
      { source: "vector", ids: ["b"] },
    ]);
    expect(equal[0]?.id).toBe("a"); // 同分，按首次出现稳定排序

    const weighted = fuseByRrf([
      { source: "fts", ids: ["a"] },
      { source: "vector", ids: ["b"], weight: 3 },
    ]);
    expect(weighted[0]?.id).toBe("b");
  });

  it("同一路内重复 ID 只按首次出现的名次计一次", () => {
    const fused = fuseByRrf([{ source: "fts", ids: ["a", "b", "a"] }]);

    expect(order(fused)).toEqual(["a", "b"]);
    expect(fused[0]?.score).toBeCloseTo(rrfScore(1), 12);
  });

  it("同分时命中路数多的在前，仍相同则按首次出现稳定排序", () => {
    // x 与 y 都只被一路命中且名次相同 → 稳定按出现顺序
    const stable = fuseByRrf([
      { source: "fts", ids: ["x"] },
      { source: "vector", ids: ["y"] },
    ]);
    expect(order(stable)).toEqual(["x", "y"]);

    // 重复跑同样输入必须得到同样输出
    expect(order(fuseByRrf([{ source: "fts", ids: ["p", "q", "r"] }]))).toEqual(["p", "q", "r"]);
  });

  it("limit 截断，且截断不改变前面的顺序", () => {
    const all = fuseByRrf([{ source: "fts", ids: ["a", "b", "c", "d"] }]);
    const limited = fuseByRrf([{ source: "fts", ids: ["a", "b", "c", "d"] }], { limit: 2 });

    expect(order(limited)).toEqual(order(all).slice(0, 2));
  });

  it("空输入、空列表、limit 0 都是正常返回而非异常", () => {
    expect(fuseByRrf([])).toEqual([]);
    expect(fuseByRrf([{ source: "fts", ids: [] }])).toEqual([]);
    expect(fuseByRrf([{ source: "fts", ids: ["a"] }], { limit: 0 })).toEqual([]);
  });

  it("k 越大名次差距越平缓（两路弱命中更容易压过单路强命中）", () => {
    const lists = [
      { source: "fts", ids: ["a", "x", "y", "b"] },
      { source: "vector", ids: ["c", "d", "e", "b"] },
    ];
    // k 很小时，第 1 名的优势被放大
    expect(fuseByRrf(lists, { k: 1 })[0]?.id).toBe("a");
    // k 很大时，两路各第 4 名的 b 累加后胜出
    expect(fuseByRrf(lists, { k: 1000 })[0]?.id).toBe("b");
  });

  it("非法 k 立即抛", () => {
    expect(() => fuseByRrf([], { k: 0 })).toThrow(RangeError);
    expect(() => fuseByRrf([], { k: Number.NaN })).toThrow(RangeError);
  });

  it("融合数字 ID（storage 侧实际传的就是 chunk rowid）", () => {
    const fused = fuseByRrf([
      { source: "fts", ids: [10, 20, 30] },
      { source: "vector", ids: [30, 40] },
    ]);

    expect(fused[0]?.id).toBe(30);
    expect(fused[0]?.sources).toEqual(["fts", "vector"]);
  });
});
