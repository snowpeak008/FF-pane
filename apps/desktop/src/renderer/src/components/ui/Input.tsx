import { Search } from "lucide-react";
import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react";
import { cn } from "../../lib/cn";
import {
  type InputVariantProps,
  inputVariants,
  type TextareaVariantProps,
  textareaVariants,
} from "./input.variants";

export type InputProps = Omit<ComponentPropsWithRef<"input">, "size"> & InputVariantProps;

/** 单行输入框（设计系统 §5.2），高 28px。错误原文由外层 Field 显示，不藏进 tooltip。 */
export function Input({ className, invalid, withLeadingIcon, ...props }: InputProps): ReactElement {
  return (
    <input
      className={cn(inputVariants({ invalid, withLeadingIcon }), className)}
      aria-invalid={invalid === true ? true : undefined}
      {...props}
    />
  );
}

export type TextareaProps = ComponentPropsWithRef<"textarea"> & TextareaVariantProps;

/** 多行输入（§5.2）：默认可纵向拉伸，会话输入框那种"随内容增高"由调用方控制行数。 */
export function Textarea({ className, invalid, ...props }: TextareaProps): ReactElement {
  return (
    <textarea
      className={cn(textareaVariants({ invalid }), className)}
      aria-invalid={invalid === true ? true : undefined}
      {...props}
    />
  );
}

export type SearchInputProps = InputProps & {
  /** 搜索图标的无障碍名（图标本身 aria-hidden，语义交给 input 的 aria-label）。 */
  readonly iconLabel?: string;
};

/**
 * 搜索框（§5.2）：左侧 14px 图标 + pl-7 让位。
 * 「/ 聚焦当前页搜索框」由各页面工单自行登记（§7），本组件只负责外观与结构。
 */
export function SearchInput({ className, iconLabel, ...props }: SearchInputProps): ReactElement {
  return (
    <div className={cn("relative flex items-center", className)}>
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2 text-fg-subtle"
        size={14}
      />
      <Input withLeadingIcon aria-label={iconLabel} {...props} />
    </div>
  );
}

export interface FieldProps {
  /** 控件的 id，用于 label 的 htmlFor 关联。 */
  readonly htmlFor: string;
  readonly label: ReactNode;
  readonly required?: boolean;
  /** 错误原文：出现时控件下方显示一行 text-xs text-danger-text（§5.2）。 */
  readonly error?: string;
  /** 补充说明，与 error 互斥显示（有错误时优先显示错误）。 */
  readonly hint?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * 表单行（§5.2）：标签在控件上方，text-xs text-fg-muted；
 * 必填项标签后加 danger 星号；禁止只用 placeholder 当标签。
 */
export function Field({
  htmlFor,
  label,
  required = false,
  error,
  hint,
  className,
  children,
}: FieldProps): ReactElement {
  const describedById = `${htmlFor}-description`;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label className="flex items-center gap-1 text-xs text-fg-muted" htmlFor={htmlFor}>
        {label}
        {required ? <span className="text-danger-text">*</span> : null}
      </label>
      {children}
      {error !== undefined ? (
        <p className="text-xs text-danger-text" id={describedById}>
          {error}
        </p>
      ) : null}
      {error === undefined && hint !== undefined ? (
        <p className="text-xs text-fg-subtle" id={describedById}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
