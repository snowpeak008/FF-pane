import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * 标签页（设计系统 §5.4，radix Tabs）：只有下划线一种形态。
 * 禁止胶囊式/卡片式 tab、图标-only tab；超过 6 个 tab 时改用侧边导航。
 */
export const Tabs = TabsPrimitive.Root;

export type TabsListProps = ComponentPropsWithRef<typeof TabsPrimitive.List>;

export function TabsList({ className, ...props }: TabsListProps): ReactElement {
  return (
    <TabsPrimitive.List
      className={cn("flex items-center gap-4 border-b border-border", className)}
      {...props}
    />
  );
}

export type TabsTriggerProps = ComponentPropsWithRef<typeof TabsPrimitive.Trigger> & {
  /** 角标（如"待审核候选 (12)"里的数字），紧随文字，text-2xs。 */
  readonly badge?: ReactNode;
};

export function TabsTrigger({
  className,
  badge,
  children,
  ...props
}: TabsTriggerProps): ReactElement {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "flex h-8 items-center gap-1 border-b-2 border-transparent px-1",
        "text-sm text-fg-muted transition-colors duration-100 hover:text-fg",
        "data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-fg",
        "disabled:cursor-not-allowed disabled:opacity-55",
        className,
      )}
      {...props}
    >
      {children}
      {badge !== undefined ? <span className="text-2xs text-fg-subtle">{badge}</span> : null}
    </TabsPrimitive.Trigger>
  );
}

export type TabsContentProps = ComponentPropsWithRef<typeof TabsPrimitive.Content>;

export function TabsContent({ className, ...props }: TabsContentProps): ReactElement {
  return <TabsPrimitive.Content className={cn("min-h-0 flex-1", className)} {...props} />;
}
