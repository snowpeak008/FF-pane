import { cva, type VariantProps } from "class-variance-authority";

/**
 * 徽章变体（设计系统 §5.7）。所有徽章共用同一骨架，只换色源：
 * 能力三态见 CAPABILITY_BADGE。
 *
 * 类名一律写成完整字面量，不用 `bg-status-${state}-surface` 这类拼接——
 * Tailwind v4 靠扫描源码文本生成 CSS，拼出来的类名不会有对应样式。
 */
export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs font-medium",
  {
    variants: {
      tone: {
        neutral: "border-border bg-surface-sunken text-fg-muted",
        primary: "border-primary-border bg-primary-surface text-primary-text",
        danger: "border-danger-border bg-danger-surface text-danger-text",
        warning: "border-warning-border bg-warning-surface text-warning-text",
        success: "border-success-border bg-success-surface text-success-text",
        /** 能力徽章自带配色，套壳时用 unstyled。 */
        unstyled: "",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeVariantProps = VariantProps<typeof badgeVariants>;

/** 圆点基准（§5.7）：14px 行内 6px 圆点，形状与颜色双重承载语义。 */
export const BADGE_DOT_BASE = "size-1.5 shrink-0 rounded-full";

export interface BadgeStyle {
  /** 徽章外框类名（底色 + 文字色 + 边框）。 */
  readonly badge: string;
  /** 圆点类名，叠加在 BADGE_DOT_BASE 之后。 */
  readonly dot: string;
}

/**
 * 适配器能力三态（§3.4）。字面量与 packages/adapters 的 CapabilitySupport 对齐；
 * 该包不是桌面端依赖，故在此重新声明，由测试保证三值齐全。
 */
export const CAPABILITY_LEVELS = ["yes", "partial", "no"] as const;
export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number];

/** 能力三态不新增 token，复用 success / warning / cancelled 三族（§3.4）。 */
export const CAPABILITY_BADGE: Readonly<Record<CapabilityLevel, BadgeStyle>> = {
  yes: {
    badge: "border-success-border bg-success-surface text-success-text",
    dot: "bg-success",
  },
  partial: {
    badge: "border-warning-border bg-warning-surface text-warning-text",
    dot: "bg-warning",
  },
  no: {
    badge: "border-border bg-status-cancelled-surface text-status-cancelled-text",
    dot: "border border-status-cancelled",
  },
};

/** 能力文案的语言包前缀。 */
export const CAPABILITY_LABEL_PREFIX = "capability.level";
