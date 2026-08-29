/** 跨包类型定义与工具函数（领域类型在 T1.1 落地）。 */
export const PACKAGE_NAME = "@ff-pane/shared";

/** 将 value 收敛到闭区间 [min, max]。 */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`clamp: min (${min}) must not be greater than max (${max})`);
  }
  return Math.min(Math.max(value, min), max);
}
