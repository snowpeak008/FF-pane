import type { ComponentPropsWithRef, ReactElement } from "react";
import { cn } from "../../lib/cn";

export type SkeletonProps = ComponentPropsWithRef<"div">;

/**
 * 骨架条（设计系统 §5.8）：形状必须仿真实布局，高度取被替代内容的行高。
 *
 * 只用于「首次进入页面 / 切换数据源的首次加载」。
 * 已有数据的刷新禁止换成骨架（用 InlineLoading 或按钮 loading）；
 * 预期 < 100ms 的加载直接渲染，不闪骨架。
 */
export function Skeleton({ className, ...props }: SkeletonProps): ReactElement {
  return (
    <div
      aria-hidden
      className={cn("h-4 rounded-sm bg-surface-sunken animate-pulse", className)}
      {...props}
    />
  );
}

/**
 * 同一容器内骨架条的宽度序列（§5.8）：宽度不能全等，否则看着像进度条。
 * 按索引取模循环使用。
 */
export const SKELETON_WIDTHS = ["w-full", "w-3/4", "w-1/2", "w-5/6"] as const;

/** 取第 index 条骨架的宽度类名。 */
export function skeletonWidth(index: number): string {
  const width = SKELETON_WIDTHS[index % SKELETON_WIDTHS.length];
  return width ?? "w-full";
}
