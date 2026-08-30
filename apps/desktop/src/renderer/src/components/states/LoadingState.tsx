import { Loader2 } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Skeleton, skeletonWidth } from "../ui/Skeleton";

export type LoadingVariant = "list" | "table" | "detail";

export interface LoadingStateProps {
  /**
   * 骨架形状必须仿真实布局（§5.8）：
   * list = 列表行，table = 表头 + 数据行，detail = 标题条 + 正文行 + 操作条。
   */
  readonly variant?: LoadingVariant;
  /** 行数，默认 4（规范建议 3~5 条）。 */
  readonly rows?: number;
  readonly className?: string;
}

/**
 * 加载态骨架屏（设计系统 §5.8 / §6.2）。
 *
 * 只用于首次进入页面或切换数据源的首次加载。
 * **已有数据的刷新禁止用它**——把已有内容换成骨架属于规范明令禁止，改用 InlineLoading
 * 或触发控件自身的 loading 态；预期 < 100ms 的加载直接渲染，不闪骨架。
 */
export function LoadingState({
  variant = "list",
  rows = 4,
  className,
}: LoadingStateProps): ReactElement {
  const { t } = useTranslation();
  const count = Math.max(1, rows);
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("common.loading")}
      className={cn("flex w-full flex-col gap-2 p-3", className)}
    >
      {variant === "detail" ? <DetailSkeleton rows={count} /> : null}
      {variant === "table" ? <TableSkeleton rows={count} /> : null}
      {variant === "list" ? <ListSkeleton rows={count} /> : null}
    </div>
  );
}

function rowKeys(count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `skeleton-row-${index}`);
}

function ListSkeleton({ rows }: { readonly rows: number }): ReactElement {
  return (
    <>
      {rowKeys(rows).map((key, index) => (
        <div key={key} className="flex h-7 items-center gap-2">
          <Skeleton className="h-4 w-12 shrink-0" />
          <Skeleton className={cn("h-4", skeletonWidth(index))} />
        </div>
      ))}
    </>
  );
}

function TableSkeleton({ rows }: { readonly rows: number }): ReactElement {
  return (
    <>
      <Skeleton className="h-7 w-full" />
      {rowKeys(rows).map((key, index) => (
        <div key={key} className="flex h-8 items-center gap-3">
          <Skeleton className={cn("h-4", skeletonWidth(index))} />
          <Skeleton className="h-4 w-16 shrink-0" />
        </div>
      ))}
    </>
  );
}

function DetailSkeleton({ rows }: { readonly rows: number }): ReactElement {
  return (
    <>
      <Skeleton className="h-6 w-1/3" />
      {rowKeys(rows).map((key, index) => (
        <Skeleton key={key} className={cn("h-4", skeletonWidth(index))} />
      ))}
      <div className="flex items-center gap-2 pt-1">
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-16" />
      </div>
    </>
  );
}

export interface InlineLoadingProps {
  /** 说明正在做什么（§6.1：1s 以上的等待要讲清在做什么）。 */
  readonly label?: string;
  readonly className?: string;
}

/**
 * 行内加载指示（§5.8 禁用骨架的场景的替代品）：
 * 已有数据的刷新、增量加载、后台任务进行中都用它，不替换已渲染的内容。
 */
export function InlineLoading({ label, className }: InlineLoadingProps): ReactElement {
  const { t } = useTranslation();
  const text = label ?? t("common.loading");
  return (
    <span
      role="status"
      aria-busy="true"
      className={cn("inline-flex items-center gap-1.5 text-xs text-fg-muted", className)}
    >
      <Loader2 aria-hidden className="animate-spin" size={14} />
      {text}
    </span>
  );
}
