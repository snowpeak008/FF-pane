import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { type CardVariantProps, cardVariants } from "./card.variants";

export type CardProps = ComponentPropsWithRef<"div"> & CardVariantProps;

/**
 * 卡片 / 面板（设计系统 §5.3）。无阴影、无渐变，层级靠 surface 色阶 + 1px 边框。
 * 需要整卡可点时用 CardButton，而不是给 div 加 onClick（§5.3 要求键盘可达）。
 */
export function Card({
  className,
  padding,
  interactive,
  selected,
  ...props
}: CardProps): ReactElement {
  return (
    <div className={cn(cardVariants({ padding, interactive, selected }), className)} {...props} />
  );
}

export type CardButtonProps = ComponentPropsWithRef<"button"> & CardVariantProps;

/** 可点击卡片：本体是 <button>，天然可聚焦、可回车触发。 */
export function CardButton({
  className,
  padding,
  selected,
  type = "button",
  ...props
}: CardButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={cn(cardVariants({ padding, selected, interactive: true }), "text-left", className)}
      {...props}
    />
  );
}

export interface CardHeaderProps {
  readonly title: ReactNode;
  /** 一句话说明，text-sm text-fg-muted。 */
  readonly description?: ReactNode;
  /** 右上角操作区，放 sm 尺寸的按钮组。 */
  readonly actions?: ReactNode;
  readonly className?: string;
}

/** 卡片头：标题左、操作右，标题层级用 text-sm font-medium（页面标题才用 text-lg）。 */
export function CardHeader({
  title,
  description,
  actions,
  className,
}: CardHeaderProps): ReactElement {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="truncate text-sm font-medium text-fg">{title}</div>
        {description !== undefined ? (
          <div className="text-sm text-fg-muted">{description}</div>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </div>
  );
}
