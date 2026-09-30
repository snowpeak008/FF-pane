/**
 * 分屏树纯函数单测（T10.2 / T10.2'）。
 */

import { describe, expect, it } from "vitest";
import {
  collectWindowIds,
  leafPane,
  normalizeSizes,
  parsePaneNode,
  percentToSizes,
  removeLeaf,
  sizesToPercent,
  splitLeaf,
  splitNodeKey,
  updateSplitSizesByKey,
  validatePaneNode,
} from "../src/shared/workbench/pane-tree";

describe("pane-tree", () => {
  it("normalizeSizes 归一与非法回退", () => {
    expect(normalizeSizes([1, 1])).toEqual([0.5, 0.5]);
    expect(normalizeSizes([3, 1])).toEqual([0.75, 0.25]);
    expect(normalizeSizes([0, 0])).toEqual([0.5, 0.5]);
    expect(normalizeSizes([Number.NaN, 2])).toEqual([0, 1]);
  });

  it("sizesToPercent / percentToSizes 往返", () => {
    const pct = sizesToPercent([0.3, 0.7]);
    expect(pct[0] + pct[1]).toBe(100);
    const back = percentToSizes(pct);
    expect(back[0] + back[1]).toBeCloseTo(1);
  });

  it("splitLeaf 水平分屏并 collect", () => {
    const root = leafPane("a");
    const split = splitLeaf(root, "a", "b", "horizontal");
    expect(split.type).toBe("split");
    if (split.type !== "split") {
      return;
    }
    expect(split.direction).toBe("horizontal");
    expect(collectWindowIds(split)).toEqual(["a", "b"]);
  });

  it("removeLeaf 折叠单侧", () => {
    const split = splitLeaf(leafPane("a"), "a", "b", "vertical");
    const afterB = removeLeaf(split, "b");
    expect(afterB).toEqual(leafPane("a"));
    const empty = removeLeaf(leafPane("a"), "a");
    expect(empty).toBeNull();
  });

  it("removeLeaf 深层嵌套：关内层叶折叠到祖父", () => {
    // ((a|b)—h—c)—v—d
    const ab = splitLeaf(leafPane("a"), "a", "b", "horizontal");
    const abc = splitLeaf(ab, "b", "c", "horizontal");
    const root = splitLeaf(abc, "c", "d", "vertical");
    expect(collectWindowIds(root)).toEqual(["a", "b", "c", "d"]);

    const withoutB = removeLeaf(root, "b");
    expect(withoutB).not.toBeNull();
    if (withoutB === null) {
      return;
    }
    expect(collectWindowIds(withoutB)).toEqual(["a", "c", "d"]);
    expect(validatePaneNode(withoutB)).toBeNull();

    const withoutA = removeLeaf(withoutB, "a");
    expect(withoutA).not.toBeNull();
    if (withoutA === null) {
      return;
    }
    // a 所在分支折叠后剩 c|d
    expect([...collectWindowIds(withoutA)].sort()).toEqual(["c", "d"]);

    const onlyD = removeLeaf(withoutA, "c");
    expect(onlyD).toEqual(leafPane("d"));
    if (onlyD === null) {
      return;
    }
    expect(removeLeaf(onlyD, "d")).toBeNull();
  });

  it("removeLeaf 深层关一侧整支后另一侧上提", () => {
    const left = splitLeaf(leafPane("a"), "a", "b", "horizontal");
    const root = splitLeaf(left, "a", "c", "vertical");
    const afterA = removeLeaf(root, "a");
    expect(afterA).not.toBeNull();
    if (afterA === null) {
      return;
    }
    const afterCloseAB = removeLeaf(afterA, "b");
    expect(afterCloseAB).toEqual(leafPane("c"));
  });

  it("updateSplitSizesByKey 按稳定键写回", () => {
    const split = splitLeaf(leafPane("a"), "a", "b", "horizontal");
    if (split.type !== "split") {
      throw new Error("expected split");
    }
    const key = splitNodeKey(split);
    const next = updateSplitSizesByKey(split, key, [0.2, 0.8]);
    expect(next.type).toBe("split");
    if (next.type === "split") {
      expect(next.sizes[0]).toBeCloseTo(0.2);
      expect(next.sizes[1]).toBeCloseTo(0.8);
    }
  });

  it("validate / parse 损坏数据", () => {
    expect(validatePaneNode(null)).not.toBeNull();
    expect(validatePaneNode({ type: "leaf" })).not.toBeNull();
    expect(validatePaneNode({ type: "leaf", windowId: "x" })).toBeNull();
    expect(parsePaneNode({ type: "nope" })).toBeNull();
    expect(parsePaneNode({ type: "leaf", windowId: "ok" })).toEqual(leafPane("ok"));
  });
});
