/**
 * 批次规划（T6.3，纯函数）。
 *
 * 两条上限同时生效：
 * - 条数上限——各家服务对单请求的 input 条数都有硬限；
 * - token 上限——比条数更贴近真实约束，32 个 800 token 的块（约 25k token）
 *   足以撞上不少服务的单请求总量限制，而 32 个短块则完全没问题。
 *
 * 单块自身就超过 token 上限时**独占一批**照常发出：宁可让服务端明确报错，
 * 也不在这里悄悄丢块——丢了的块在检索里永远不会出现，且无人察觉。
 */

/** 批次规划参数。 */
export interface BatchPlanParams {
  /** 单批最多多少条。 */
  readonly maxItems: number;
  /** 单批最多多少 token。 */
  readonly maxTokens: number;
}

/**
 * 贪心切批：按输入顺序累积，加不下就收口。
 * 保序且不重不漏——`planBatches(items).flat()` 恒等于 `items`。
 */
export function planBatches<T>(
  items: readonly T[],
  tokensOf: (item: T) => number,
  params: BatchPlanParams,
): readonly (readonly T[])[] {
  const { maxItems, maxTokens } = params;
  if (!Number.isInteger(maxItems) || maxItems <= 0) {
    throw new RangeError(`planBatches: maxItems 必须是正整数，实际 ${maxItems}`);
  }
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new RangeError(`planBatches: maxTokens 必须是正数，实际 ${maxTokens}`);
  }

  const batches: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const tokens = tokensOf(item);
    const overflows = current.length >= maxItems || currentTokens + tokens > maxTokens;
    // current 为空时不收口：否则超限的单块会被无限推迟，永远进不了任何一批
    if (overflows && current.length > 0) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += tokens;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}
