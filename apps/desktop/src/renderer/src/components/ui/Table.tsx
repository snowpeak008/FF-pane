import type { ComponentPropsWithRef, ReactElement } from "react";
import { cn } from "../../lib/cn";
import {
  ROW_ACTIONS_CLASS,
  TABLE_HEAD_CLASS,
  type TableCellVariantProps,
  type TableRowVariantProps,
  tableCellVariants,
  tableRowVariants,
} from "./table.variants";

export type TableProps = ComponentPropsWithRef<"table">;

/**
 * 表格基元（设计系统 §5.6）。禁止斑马纹与竖向网格线；
 * 超过 200 行必须由调用方虚拟化（那时改用 ListRow 手搭行）。
 */
export function Table({ className, ...props }: TableProps): ReactElement {
  return <table className={cn("w-full border-collapse text-sm text-fg", className)} {...props} />;
}

export type TableSectionProps = ComponentPropsWithRef<"thead">;

/** 表头容器：sticky 定位由 TableHead 的类名承担。 */
export function TableHeader({ className, ...props }: TableSectionProps): ReactElement {
  return <thead className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentPropsWithRef<"tbody">): ReactElement {
  return <tbody className={className} {...props} />;
}

export type TableHeadProps = ComponentPropsWithRef<"th">;

/** 表头单元格：sticky top-0 + 凹陷底色 + 28px 行高。 */
export function TableHead({ className, scope = "col", ...props }: TableHeadProps): ReactElement {
  return <th scope={scope} className={cn(TABLE_HEAD_CLASS, className)} {...props} />;
}

export type TableRowProps = ComponentPropsWithRef<"tr"> & TableRowVariantProps;

/** 数据行：hover 换底、选中加左边条；行内操作默认隐藏（ROW_ACTIONS_CLASS）。 */
export function TableRow({
  className,
  density,
  interactive,
  selected,
  ...props
}: TableRowProps): ReactElement {
  return (
    <tr
      className={cn(tableRowVariants({ density, interactive, selected }), className)}
      aria-selected={selected === true ? true : undefined}
      {...props}
    />
  );
}

export type TableCellProps = ComponentPropsWithRef<"td"> & TableCellVariantProps;

export function TableCell({
  className,
  align,
  mono,
  truncate,
  ...props
}: TableCellProps): ReactElement {
  return <td className={cn(tableCellVariants({ align, mono, truncate }), className)} {...props} />;
}

export type ListRowProps = ComponentPropsWithRef<"div"> & TableRowVariantProps;

/**
 * 非表格场景的行基元：与 TableRow 同一套状态类名，用于虚拟列表与卡片式列表。
 * 需要整行可点时由调用方套 <button>/<a> 或给 role + 键盘处理（§5.6 键盘可达）。
 */
export function ListRow({
  className,
  density,
  interactive,
  selected,
  ...props
}: ListRowProps): ReactElement {
  return (
    <div
      className={cn(
        tableRowVariants({ density, interactive, selected }),
        "flex items-center gap-2 px-2",
        className,
      )}
      {...props}
    />
  );
}

export type RowActionsProps = ComponentPropsWithRef<"div">;

/** 行内操作条：默认 opacity-0，行 hover 或内部元素获得焦点时显形（§5.6）。 */
export function RowActions({ className, ...props }: RowActionsProps): ReactElement {
  return <div className={cn(ROW_ACTIONS_CLASS, className)} {...props} />;
}
