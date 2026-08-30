import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface SettingRowProps {
  readonly label: ReactNode;
  /** 一行补充说明（text-xs text-fg-subtle）。 */
  readonly description?: ReactNode;
  /** 关联控件的 id（label 的 htmlFor）。 */
  readonly htmlFor?: string;
  /** 右侧控件。 */
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * 设置行（标量偏好的统一布局）：标签+说明在左，控件在右。
 * 与表单 Field（标签在控件上方）区分：设置页里的开关 / 下拉是行式布局，密度更高。
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  children,
  className,
}: SettingRowProps): ReactElement {
  return (
    <div className={cn("flex items-center justify-between gap-4 py-2", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label className="text-sm text-fg" htmlFor={htmlFor}>
          {label}
        </label>
        {description !== undefined ? (
          <span className="text-xs text-fg-subtle">{description}</span>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
