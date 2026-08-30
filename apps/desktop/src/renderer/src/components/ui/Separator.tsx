import * as SeparatorPrimitive from "@radix-ui/react-separator";
import type { ComponentPropsWithRef, ReactElement } from "react";
import { cn } from "../../lib/cn";

export type SeparatorProps = ComponentPropsWithRef<typeof SeparatorPrimitive.Root>;

/** 分隔线（设计系统 §4.6）：一律 1px 语义边框色，不用 <hr>，不用 2px+ 粗线。 */
export function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: SeparatorProps): ReactElement {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      decorative={decorative}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}
