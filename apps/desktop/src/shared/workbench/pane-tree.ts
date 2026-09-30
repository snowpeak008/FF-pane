/**
 * 分屏树纯函数（T10.2）：分割、关闭叶子后折叠、比例归一、序列化/校验。
 */

import type { PaneLeaf, PaneNode, PaneSplit, PaneSplitDirection } from "@ff-pane/shared";

const EPSILON = 1e-9;

/** 新建单叶树。 */
export function leafPane(windowId: string): PaneLeaf {
  return { type: "leaf", windowId };
}

/** 将 sizes 归一为和为 1 的二元组；非法输入回退 0.5/0.5。 */
export function normalizeSizes(sizes: readonly [number, number]): readonly [number, number] {
  const a = Number.isFinite(sizes[0]) ? Math.max(0, sizes[0]) : 0;
  const b = Number.isFinite(sizes[1]) ? Math.max(0, sizes[1]) : 0;
  const sum = a + b;
  if (sum <= EPSILON) {
    return [0.5, 0.5];
  }
  return [a / sum, b / sum];
}

/** 比例 → react-resizable-panels 百分数（1–100）。 */
export function sizesToPercent(sizes: readonly [number, number]): readonly [number, number] {
  const [a, b] = normalizeSizes(sizes);
  void b;
  const left = Math.max(1, Math.min(99, Math.round(a * 100)));
  return [left, 100 - left];
}

/** 百分数 → 比例。 */
export function percentToSizes(percents: readonly [number, number]): readonly [number, number] {
  return normalizeSizes([percents[0] / 100, percents[1] / 100]);
}

/** 收集树中全部 windowId（去重保序）。 */
export function collectWindowIds(node: PaneNode): readonly string[] {
  if (node.type === "leaf") {
    return [node.windowId];
  }
  return [...collectWindowIds(node.children[0]), ...collectWindowIds(node.children[1])];
}

/** 树中是否包含指定窗口。 */
export function treeContainsWindow(node: PaneNode, windowId: string): boolean {
  if (node.type === "leaf") {
    return node.windowId === windowId;
  }
  return (
    treeContainsWindow(node.children[0], windowId) || treeContainsWindow(node.children[1], windowId)
  );
}

/**
 * 在目标叶子处二分：原窗口留在一侧，新窗口在另一侧。
 * direction=horizontal → 原左新右；vertical → 原上新下。
 * 找不到目标叶子时返回原树。
 */
export function splitLeaf(
  node: PaneNode,
  targetWindowId: string,
  newWindowId: string,
  direction: PaneSplitDirection,
): PaneNode {
  if (node.type === "leaf") {
    if (node.windowId !== targetWindowId) {
      return node;
    }
    const split: PaneSplit = {
      type: "split",
      direction,
      sizes: [0.5, 0.5],
      children: [leafPane(targetWindowId), leafPane(newWindowId)],
    };
    return split;
  }
  const left = splitLeaf(node.children[0], targetWindowId, newWindowId, direction);
  if (left !== node.children[0]) {
    return { ...node, children: [left, node.children[1]] };
  }
  const right = splitLeaf(node.children[1], targetWindowId, newWindowId, direction);
  if (right !== node.children[1]) {
    return { ...node, children: [node.children[0], right] };
  }
  return node;
}

/**
 * 关闭叶子并折叠：若父节点只剩一侧，用该侧取代父节点。
 * 关闭根叶子返回 null（整树空）。
 */
export function removeLeaf(node: PaneNode, windowId: string): PaneNode | null {
  if (node.type === "leaf") {
    return node.windowId === windowId ? null : node;
  }
  const left = removeLeaf(node.children[0], windowId);
  const right = removeLeaf(node.children[1], windowId);
  if (left === null && right === null) {
    return null;
  }
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  if (left === node.children[0] && right === node.children[1]) {
    return node;
  }
  return { ...node, children: [left, right], sizes: normalizeSizes(node.sizes) };
}

/** 更新某二分节点的比例（按子树内任一 windowId 定位最近祖先 split 亦可，此处按整树路径替换）。 */
export function updateSplitSizes(
  node: PaneNode,
  pathMatcher: (split: PaneSplit) => boolean,
  sizes: readonly [number, number],
): PaneNode {
  if (node.type === "leaf") {
    return node;
  }
  if (pathMatcher(node)) {
    return { ...node, sizes: normalizeSizes(sizes) };
  }
  return {
    ...node,
    children: [
      updateSplitSizes(node.children[0], pathMatcher, sizes),
      updateSplitSizes(node.children[1], pathMatcher, sizes),
    ],
  };
}

/** 按「含某窗口的直接父 split」更新比例。 */
export function updateSizesForWindowParent(
  node: PaneNode,
  windowId: string,
  sizes: readonly [number, number],
): PaneNode {
  if (node.type === "leaf") {
    return node;
  }
  const leftHas =
    node.children[0].type === "leaf"
      ? node.children[0].windowId === windowId
      : treeContainsWindow(node.children[0], windowId);
  const rightHas =
    node.children[1].type === "leaf"
      ? node.children[1].windowId === windowId
      : treeContainsWindow(node.children[1], windowId);
  // 直接父：一侧是该叶子
  if (
    (node.children[0].type === "leaf" && node.children[0].windowId === windowId) ||
    (node.children[1].type === "leaf" && node.children[1].windowId === windowId)
  ) {
    return { ...node, sizes: normalizeSizes(sizes) };
  }
  if (leftHas) {
    return {
      ...node,
      children: [updateSizesForWindowParent(node.children[0], windowId, sizes), node.children[1]],
    };
  }
  if (rightHas) {
    return {
      ...node,
      children: [node.children[0], updateSizesForWindowParent(node.children[1], windowId, sizes)],
    };
  }
  return node;
}

/** 深克隆式替换某 split 的 sizes（用 children 两端叶子 id 作稳定键）。相等则返回原节点。 */
export function updateSplitSizesByKey(
  node: PaneNode,
  splitKey: string,
  sizes: readonly [number, number],
): PaneNode {
  if (node.type === "leaf") {
    return node;
  }
  if (splitNodeKey(node) === splitKey) {
    const next = normalizeSizes(sizes);
    if (
      Math.abs(node.sizes[0] - next[0]) < EPSILON &&
      Math.abs(node.sizes[1] - next[1]) < EPSILON
    ) {
      return node;
    }
    return { ...node, sizes: next };
  }
  const left = updateSplitSizesByKey(node.children[0], splitKey, sizes);
  const right = updateSplitSizesByKey(node.children[1], splitKey, sizes);
  if (left === node.children[0] && right === node.children[1]) {
    return node;
  }
  return {
    ...node,
    children: [left, right],
  };
}

/** 稳定键：方向 + 两端叶子集合（便于 onLayout 回写）。 */
export function splitNodeKey(node: PaneSplit): string {
  const ids = collectWindowIds(node).slice().sort();
  return `${node.direction}:${ids.join(",")}`;
}

/** 结构校验：失败返回原因字符串，通过返回 null。 */
export function validatePaneNode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "pane node must be an object";
  }
  const raw = value as { readonly type?: unknown };
  if (raw.type === "leaf") {
    const leaf = value as { readonly windowId?: unknown };
    if (typeof leaf.windowId !== "string" || leaf.windowId.trim() === "") {
      return "leaf.windowId must be a non-empty string";
    }
    return null;
  }
  if (raw.type === "split") {
    const split = value as {
      readonly direction?: unknown;
      readonly sizes?: unknown;
      readonly children?: unknown;
    };
    if (split.direction !== "horizontal" && split.direction !== "vertical") {
      return "split.direction must be horizontal|vertical";
    }
    if (
      !Array.isArray(split.sizes) ||
      split.sizes.length !== 2 ||
      typeof split.sizes[0] !== "number" ||
      typeof split.sizes[1] !== "number"
    ) {
      return "split.sizes must be [number, number]";
    }
    if (!Array.isArray(split.children) || split.children.length !== 2) {
      return "split.children must have length 2";
    }
    const left = validatePaneNode(split.children[0]);
    if (left !== null) {
      return left;
    }
    return validatePaneNode(split.children[1]);
  }
  return "pane node type must be leaf|split";
}

/** 反序列化：损坏返回 null。 */
export function parsePaneNode(value: unknown): PaneNode | null {
  if (validatePaneNode(value) !== null) {
    return null;
  }
  return normalizePaneNode(value as PaneNode);
}

/** 归一化已通过校验的树（sizes 归一）。 */
export function normalizePaneNode(node: PaneNode): PaneNode {
  if (node.type === "leaf") {
    return leafPane(node.windowId);
  }
  return {
    type: "split",
    direction: node.direction,
    sizes: normalizeSizes(node.sizes),
    children: [normalizePaneNode(node.children[0]), normalizePaneNode(node.children[1])],
  };
}
