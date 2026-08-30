import { cva, type VariantProps } from "class-variance-authority";

/**
 * 表格 / 列表行基元（设计系统 §5.6）。
 * 禁止斑马纹与竖向网格线：行的边界只由 border-b 表达。
 */
export const tableRowVariants = cva("group border-b border-border transition-colors duration-100", {
  variants: {
    /** compact = 28px 行高，default = 32px（§1.1 信息密度）。 */
    density: { compact: "h-7", default: "h-8" },
    interactive: { true: "cursor-pointer hover:bg-surface-hover", false: "" },
    selected: { true: "border-l-2 border-l-primary bg-surface-active", false: "" },
  },
  defaultVariants: { density: "default", interactive: false, selected: false },
});

export const tableCellVariants = cva("px-2 align-middle", {
  variants: {
    /** 数值右对齐并等宽对位（§5.6）。 */
    align: { left: "text-left", right: "text-right tabular-nums", center: "text-center" },
    /** 时间、路径、ID、退出码一律 font-mono text-xs（§4.3）。 */
    mono: { true: "font-mono text-xs", false: "" },
    truncate: { true: "truncate", false: "" },
  },
  defaultVariants: { align: "left", mono: false, truncate: false },
});

/** 表头：sticky + 凹陷底色 + 28px 行高（§5.6）。 */
export const TABLE_HEAD_CLASS =
  "sticky top-0 z-10 h-7 bg-surface-sunken px-2 text-left text-xs font-medium text-fg-muted";

/**
 * 行内操作条：默认隐藏，hover 或键盘聚焦时显形（§5.6）。
 * 依赖行上的 `group` 类（已在 tableRowVariants 的基准里）。
 */
export const ROW_ACTIONS_CLASS =
  "flex items-center gap-1 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100";

export type TableRowVariantProps = VariantProps<typeof tableRowVariants>;
export type TableCellVariantProps = VariantProps<typeof tableCellVariants>;
