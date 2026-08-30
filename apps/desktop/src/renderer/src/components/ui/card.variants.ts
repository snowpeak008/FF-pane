import { cva, type VariantProps } from "class-variance-authority";

/**
 * 卡片 / 面板变体（设计系统 §5.3）。
 * 规范禁止卡片带阴影：层级只靠 surface 色阶与 1px 边框表达。
 */
export const cardVariants = cva("rounded-md border border-border bg-surface", {
  variants: {
    /** compact = 密集列表卡片（12px），default = 详情面板（16px），none 交给调用方自排版。 */
    padding: { none: "p-0", compact: "p-3", default: "p-4" },
    interactive: {
      true: "cursor-pointer transition-colors duration-100 hover:border-border-strong hover:bg-surface-hover",
      false: "",
    },
    selected: { true: "border-primary bg-surface-active", false: "" },
  },
  defaultVariants: { padding: "default", interactive: false, selected: false },
});

export type CardVariantProps = VariantProps<typeof cardVariants>;
