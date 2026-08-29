/** 跨包类型定义与工具函数。领域类型见 ./domain（W1.1 定稿，唯一事实来源）。 */
export const PACKAGE_NAME = "@ff-pane/shared";

export * from "./domain/index.js";

/** 将 value 收敛到闭区间 [min, max]。 */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`clamp: min (${min}) must not be greater than max (${max})`);
  }
  return Math.min(Math.max(value, min), max);
}
