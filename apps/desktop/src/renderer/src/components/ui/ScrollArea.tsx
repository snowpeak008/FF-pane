import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface ScrollAreaProps {
  readonly className?: string;
  /** 视口的附加类名（内容排版一般写在这里）。 */
  readonly viewportClassName?: string;
  readonly orientation?: "vertical" | "horizontal" | "both";
  readonly children: ReactNode;
}

/**
 * 滚动容器（radix ScrollArea）：滑块用 border-strong，与全局 scrollbar-color 一致。
 * 长列表（> 200 行）的虚拟化由各页面工单自行接入，本组件只统一滚动条外观。
 */
export function ScrollArea({
  className,
  viewportClassName,
  orientation = "vertical",
  children,
}: ScrollAreaProps): ReactElement {
  return (
    <ScrollAreaPrimitive.Root className={cn("overflow-hidden", className)} type="hover">
      <ScrollAreaPrimitive.Viewport className={cn("size-full", viewportClassName)}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      {orientation !== "horizontal" ? <Scrollbar orientation="vertical" /> : null}
      {orientation !== "vertical" ? <Scrollbar orientation="horizontal" /> : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function Scrollbar({
  orientation,
}: {
  readonly orientation: "vertical" | "horizontal";
}): ReactElement {
  return (
    <ScrollAreaPrimitive.Scrollbar
      orientation={orientation}
      className={cn(
        "flex touch-none select-none transition-opacity duration-150",
        orientation === "vertical" ? "w-2" : "h-2 flex-col",
      )}
    >
      {/* rounded-full 按 §4.4 只留给状态圆点，滚动条滑块取 rounded-sm */}
      <ScrollAreaPrimitive.Thumb className="flex-1 rounded-sm bg-border-strong" />
    </ScrollAreaPrimitive.Scrollbar>
  );
}
