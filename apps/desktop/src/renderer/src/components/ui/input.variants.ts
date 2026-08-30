import { cva, type VariantProps } from "class-variance-authority";

/** 输入类控件的共用基准（设计系统 §5.2）。 */
const CONTROL_BASE = [
  "w-full rounded-sm border bg-surface px-2 text-sm text-fg",
  "transition-colors duration-100 placeholder:text-fg-subtle",
  // 只读的路径/ID 值必须可选中复制，所以只换底色，不禁用指针
  "read-only:bg-surface-sunken",
  "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-fg-subtle",
];

/** 错误态只改边框色；错误原文由 Field 在控件下方以 text-xs text-danger-text 显示。 */
const INVALID_VARIANT = {
  true: "border-danger",
  false: "border-border-strong",
} as const;

export const inputVariants = cva([...CONTROL_BASE, "h-7"], {
  variants: {
    invalid: INVALID_VARIANT,
    /** 搜索框：左侧留出 14px 图标的位置（§5.2）。 */
    withLeadingIcon: { true: "pl-7", false: "" },
  },
  defaultVariants: { invalid: false, withLeadingIcon: false },
});

export const textareaVariants = cva([...CONTROL_BASE, "min-h-16 resize-y py-1"], {
  variants: { invalid: INVALID_VARIANT },
  defaultVariants: { invalid: false },
});

export type InputVariantProps = VariantProps<typeof inputVariants>;
export type TextareaVariantProps = VariantProps<typeof textareaVariants>;
