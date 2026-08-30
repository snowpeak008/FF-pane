import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Tooltip 提供者：整个应用挂一个（见 App.tsx）。
 * 200ms 延迟属于「交互反馈 < 100ms 之外的浮层」，不算装饰动效。
 */
export function TooltipProvider({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <TooltipPrimitive.Provider delayDuration={200} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  /** 提示正文（已翻译）。 */
  readonly content: ReactNode;
  /**
   * 键位提示（§6.4：按钮 tooltip 右侧显示键位，font-mono text-2xs text-fg-subtle）。
   * 直接写键位串如 "Ctrl+1"，不进语言包（键名不翻译）。
   */
  readonly shortcut?: string;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
  /**
   * 触发元素包一层 span 再挂事件。
   * 禁用按钮带 `pointer-events-none`（§5.1），必须开这个才能显示"为什么不可用"。
   */
  readonly wrapTrigger?: boolean;
  readonly children: ReactElement;
}

/** 标准 tooltip（设计系统 §4.5 阴影只用于浮层、§6.4 键位提示）。 */
export function Tooltip({
  content,
  shortcut,
  side = "top",
  align = "center",
  wrapTrigger = false,
  children,
}: TooltipProps): ReactElement {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        {wrapTrigger ? <span className="inline-flex">{children}</span> : children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            "z-50 flex max-w-64 items-center gap-2",
            "rounded-md border border-border bg-surface-raised px-2 py-1",
            "text-xs text-fg shadow-raised",
          )}
        >
          <span className="min-w-0">{content}</span>
          {shortcut !== undefined ? (
            <kbd className="shrink-0 font-mono text-2xs text-fg-subtle">{shortcut}</kbd>
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
