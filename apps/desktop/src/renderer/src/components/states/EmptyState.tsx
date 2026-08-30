import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";

export interface EmptyStateAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface EmptyStateProps {
  /**
   * 一句话说明（§6.2 格式："<还没有什么>。<下一步动作>。"）。
   * 禁止"暂无数据"式无信息文案；文案必须来自语言包。
   */
  readonly message: string;
  /**
   * 唯一的主操作。API 只接受一个动作对象——空态里放多个按钮是规范明令禁止的。
   * 占位页 / 无动作可做的空态可以省略。
   */
  readonly action?: EmptyStateAction;
  /** 可选图标（16px，fg-subtle）。禁止插画。 */
  readonly icon?: LucideIcon;
  readonly className?: string;
}

/**
 * 空态（设计系统 §6.2 / 开发计划 §1.5 第 2 条）。
 *
 * 区分"空"与"错"：请求失败必须走 ErrorState，不允许退化成空态——按 bug 对待。
 */
export function EmptyState({
  message,
  action,
  icon: Icon,
  className,
}: EmptyStateProps): ReactElement {
  return (
    <div
      className={cn(
        "flex h-full min-h-32 flex-col items-center justify-center gap-3 p-6 text-center",
        className,
      )}
    >
      <div className="flex flex-col items-center gap-2">
        {Icon !== undefined ? <Icon aria-hidden className="text-fg-subtle" size={16} /> : null}
        <p className="max-w-md text-sm text-fg-muted">{message}</p>
      </div>
      {action !== undefined ? (
        <Button variant="primary" size="lg" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
