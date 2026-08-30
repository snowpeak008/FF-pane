import { TASK_STATUSES, type TaskStatus } from "@ff-pane/shared";
import { cva, type VariantProps } from "class-variance-authority";

/**
 * 徽章变体（设计系统 §5.7）。所有徽章共用同一骨架，只换色源：
 * 任务 7 态见 TASK_STATUS_BADGE，能力三态见 CAPABILITY_BADGE。
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
        /** 状态徽章自带配色，套壳时用 unstyled 让 TASK_STATUS_BADGE 的类名接管。 */
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
 * 任务 7 态徽章（§3.3 / §5.7）。两条产品硬规则在此固化：
 *   1. done ≠ accepted —— "AI 说完成" 不等于 "项目认为完成"，用独立青色与绿色区分。
 *   2. cancelled 与 pending 同为中性灰，靠形状区分：虚线边框 + 空心圆环。
 * running 的圆点是徽章上唯一允许的动效。
 */
export const TASK_STATUS_BADGE: Readonly<Record<TaskStatus, BadgeStyle>> = {
  pending: {
    badge: "border-transparent bg-status-pending-surface text-status-pending-text",
    dot: "bg-status-pending",
  },
  running: {
    badge: "border-transparent bg-status-running-surface text-status-running-text",
    dot: "animate-pulse bg-status-running",
  },
  blocked: {
    badge: "border-transparent bg-status-blocked-surface text-status-blocked-text",
    dot: "bg-status-blocked",
  },
  failed: {
    badge: "border-transparent bg-status-failed-surface text-status-failed-text",
    dot: "bg-status-failed",
  },
  done: {
    badge: "border-transparent bg-status-done-surface text-status-done-text",
    dot: "bg-status-done",
  },
  accepted: {
    badge: "border-transparent bg-status-accepted-surface text-status-accepted-text",
    dot: "bg-status-accepted",
  },
  cancelled: {
    badge: "border-dashed border-border bg-status-cancelled-surface text-status-cancelled-text",
    dot: "border border-status-cancelled",
  },
};

export type { TaskStatus };
/** 任务状态清单（转发领域层定义，保证 UI 枚举与状态机永不脱节）。 */
export { TASK_STATUSES };

/** 任务状态文案的语言包前缀（§5.7：徽章必须带文字，禁止只有圆点）。 */
export const TASK_STATUS_LABEL_PREFIX = "task.status";

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
