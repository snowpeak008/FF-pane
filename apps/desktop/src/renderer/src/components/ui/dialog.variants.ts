import { cva, type VariantProps } from "class-variance-authority";

/**
 * 对话框内容框变体（设计系统 §5.5）。
 * 三档宽度对应三类用途，圆角上限 lg（8px），阴影只允许出现在浮层。
 */
export const dialogContentVariants = cva(
  [
    "fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
    "flex max-h-dvh w-full flex-col gap-3",
    "rounded-lg border border-border bg-surface-raised p-4 shadow-overlay",
  ],
  {
    variants: {
      size: {
        /** 确认类 */
        confirm: "max-w-md",
        /** 表单类 */
        form: "max-w-2xl",
        /** diff 预览类 */
        diff: "max-w-4xl",
      },
    },
    defaultVariants: { size: "confirm" },
  },
);

export type DialogContentVariantProps = VariantProps<typeof dialogContentVariants>;

export const DIALOG_SIZES = ["confirm", "form", "diff"] as const;
export type DialogSize = (typeof DIALOG_SIZES)[number];

/**
 * 「输入名称确认」超危险档的判定（§5.5）：用户输入必须与对象名逐字符相等，
 * 只容忍首尾空白（Windows 上从资源管理器复制路径常带尾空格）。不匹配则确认按钮保持 disabled。
 */
export function isConfirmationSatisfied(required: string | undefined, typed: string): boolean {
  if (required === undefined) {
    return true;
  }
  const expected = required.trim();
  if (expected.length === 0) {
    return true;
  }
  return typed.trim() === expected;
}
