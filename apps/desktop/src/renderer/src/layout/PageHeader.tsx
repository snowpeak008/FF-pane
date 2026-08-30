import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface PageHeaderProps {
  readonly title: ReactNode;
  /** 该页面回答的那一个问题，或一行上下文（text-xs text-fg-muted）。 */
  readonly description?: ReactNode;
  /** 右侧操作区：放 sm/md 尺寸按钮，每屏至多一个 primary。 */
  readonly actions?: ReactNode;
  readonly className?: string;
}

/**
 * 页面头部条（内容区顶部的预留位置）。
 *
 * 布局约定：AppLayout 只提供"侧栏 + 内容列"，内容列顶部由各页面自己填——
 * 会话页的常驻状态条（§11.2）、任务页的筛选条等都是页面自有头部，归各自工单。
 * 本组件是那一行的统一外观基准（36px 高、1px 下边框、无阴影），供页面直接复用。
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps): ReactElement {
  return (
    <header
      className={cn(
        "flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4",
        className,
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="truncate text-sm font-medium text-fg">{title}</h1>
        {description !== undefined ? (
          <span className="truncate text-xs text-fg-muted">{description}</span>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </header>
  );
}
