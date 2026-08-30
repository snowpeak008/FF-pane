import { cva, type VariantProps } from "class-variance-authority";

/**
 * 按钮变体（设计系统 §5.1）：5 个层级 × 3 个尺寸，外加图标按钮的正方形形态。
 * 类名串照抄规范表格，不在此处发明新色值或新尺寸档。
 *
 * 变体定义单独成文件（而非写在 Button.tsx 里）的原因：
 * 纯逻辑可被 tests/ui-components.test.ts 在 node 环境直接断言，无需 DOM。
 */
export const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm font-medium",
    "transition-colors duration-100 active:translate-y-px",
    // disabled:pointer-events-none 是规范原文；因此禁用按钮的 tooltip 必须包一层
    // 可接收事件的元素（见 Tooltip 的 wrapTrigger 入参）
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-55",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-fg hover:bg-primary-hover",
        secondary: "border border-border-strong bg-surface text-fg hover:bg-surface-hover",
        ghost: "text-fg-muted hover:bg-surface-hover hover:text-fg",
        danger: "bg-danger text-danger-fg hover:bg-danger-hover",
        link: "text-primary-text underline-offset-2 hover:underline",
      },
      size: {
        sm: "h-6 gap-1 px-2 text-xs",
        md: "h-7 gap-1.5 px-2.5 text-sm",
        lg: "h-8 gap-1.5 px-3 text-sm",
      },
      /** 图标按钮：去掉横向内边距并压成正方形，尺寸由 compoundVariants 按档给出。 */
      iconOnly: { true: "px-0", false: "" },
    },
    compoundVariants: [
      { iconOnly: true, size: "sm", class: "size-6" },
      { iconOnly: true, size: "md", class: "size-7" },
      { iconOnly: true, size: "lg", class: "size-8" },
    ],
    // 默认按钮是 secondary（§5.1：primary 每屏至多一个，不能当默认值）
    defaultVariants: { variant: "secondary", size: "md", iconOnly: false },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

/** 层级清单，供测试遍历与命令面板/文档枚举。 */
export const BUTTON_VARIANTS = ["primary", "secondary", "ghost", "danger", "link"] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

/** 尺寸清单（高度 24 / 28 / 32px）。 */
export const BUTTON_SIZES = ["sm", "md", "lg"] as const;
export type ButtonSize = (typeof BUTTON_SIZES)[number];

/** 各尺寸档的图标边长（px，§5.1：sm 用 14、md 起用 16）。 */
export const BUTTON_ICON_SIZE: Readonly<Record<ButtonSize, number>> = {
  sm: 14,
  md: 16,
  lg: 16,
};
