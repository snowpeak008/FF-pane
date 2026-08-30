import type { ComponentPropsWithRef, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import {
  BADGE_DOT_BASE,
  type BadgeVariantProps,
  badgeVariants,
  CAPABILITY_BADGE,
  CAPABILITY_LABEL_PREFIX,
  type CapabilityLevel,
  TASK_STATUS_BADGE,
  TASK_STATUS_LABEL_PREFIX,
  type TaskStatus,
} from "./badge.variants";

export type BadgeProps = ComponentPropsWithRef<"span"> &
  BadgeVariantProps & {
    /** 圆点的附加类名；给了才渲染圆点（§5.7：图标不单独承载语义，必须配文字）。 */
    readonly dotClassName?: string;
  };

/** 徽章骨架（设计系统 §5.7）。所有徽章共用这一实现，只换色源。 */
export function Badge({
  className,
  tone,
  dotClassName,
  children,
  ...props
}: BadgeProps): ReactElement {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dotClassName !== undefined ? (
        <span aria-hidden className={cn(BADGE_DOT_BASE, dotClassName)} />
      ) : null}
      {children}
    </span>
  );
}

export interface TaskStatusBadgeProps {
  readonly status: TaskStatus;
  readonly className?: string;
}

/**
 * 任务状态徽章（§3.3 / §5.7）：7 态各一色，文案走 `task.status.<state>`。
 * done 与 accepted 必须不同色；cancelled 用虚线框 + 空心圆环与 pending 区分。
 */
export function TaskStatusBadge({ status, className }: TaskStatusBadgeProps): ReactElement {
  const { t } = useTranslation();
  const style = TASK_STATUS_BADGE[status];
  return (
    <Badge
      tone="unstyled"
      className={cn(style.badge, className)}
      dotClassName={style.dot}
      title={t(`${TASK_STATUS_LABEL_PREFIX}.${status}`)}
    >
      {t(`${TASK_STATUS_LABEL_PREFIX}.${status}`)}
    </Badge>
  );
}

export interface CapabilityBadgeProps {
  readonly level: CapabilityLevel;
  /**
   * partial 档的具体限制说明（§3.4 硬性要求："部分支持"不允许只给一个颜色）。
   * 调用方须传已翻译好的文案；本组件只负责把它挂到 title 上。
   */
  readonly detail?: string;
  readonly className?: string;
}

/** 适配器能力三态徽章（§3.4），复用 success / warning / cancelled 三族，不新增 token。 */
export function CapabilityBadge({ level, detail, className }: CapabilityBadgeProps): ReactElement {
  const { t } = useTranslation();
  const style = CAPABILITY_BADGE[level];
  const label = t(`${CAPABILITY_LABEL_PREFIX}.${level}`);
  return (
    <Badge
      tone="unstyled"
      className={cn(style.badge, className)}
      dotClassName={style.dot}
      title={detail ?? label}
    >
      {label}
    </Badge>
  );
}
