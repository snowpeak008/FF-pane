import { Loader2 } from "lucide-react";
import type { ComponentPropsWithRef, ReactElement } from "react";
import { cn } from "../../lib/cn";
import { BUTTON_ICON_SIZE, type ButtonVariantProps, buttonVariants } from "./button.variants";

export interface ButtonProps extends ComponentPropsWithRef<"button">, ButtonVariantProps {
  /**
   * 加载中：保持原尺寸防跳动，文字前插旋转图标，同时置 disabled 与 aria-busy（§5.1）。
   * 100ms~1s 的操作用它，超过 1s 的改用区块级进度或后台任务（§6.1）。
   */
  readonly loading?: boolean;
}

/**
 * 标准按钮（设计系统 §5.1）。
 *
 * - 层级：primary / secondary / ghost / danger / link，每屏至多一个 primary。
 * - 尺寸：sm 24px（行内）/ md 28px（默认）/ lg 32px（对话框主操作、空态动作）。
 * - `iconOnly` 图标按钮必须自带 `aria-label` 与 tooltip。
 * - 禁用态带 `pointer-events-none`，要挂 tooltip 说明"为什么不可用"时，
 *   用 `<Tooltip wrapTrigger>` 包一层可接收事件的元素。
 * - 需要把按钮外观套到 `<Link>`/`<a>` 上时，直接用 `buttonVariants()` 生成类名，
 *   不走 asChild（保持 props 类型严格）。
 */
export function Button({
  className,
  variant,
  size,
  iconOnly,
  loading = false,
  disabled = false,
  children,
  type = "button",
  ...props
}: ButtonProps): ReactElement {
  const iconSize = BUTTON_ICON_SIZE[size ?? "md"];
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size, iconOnly }), className)}
      disabled={disabled || loading}
      aria-busy={loading}
      {...props}
    >
      {loading ? <Loader2 aria-hidden className="animate-spin" size={iconSize} /> : null}
      {children}
    </button>
  );
}
