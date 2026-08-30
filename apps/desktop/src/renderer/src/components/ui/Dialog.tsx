import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "./Button";
import { type DialogContentVariantProps, dialogContentVariants } from "./dialog.variants";

/**
 * 对话框（设计系统 §5.5，radix Dialog）。
 * radix 自带：Esc 关闭、点遮罩关闭、焦点 trap 与关闭后焦点还原。
 * 禁止嵌套对话框；能内联完成的编辑不要塞进对话框；不允许无标题的对话框。
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export type DialogContentProps = ComponentPropsWithRef<typeof DialogPrimitive.Content> &
  DialogContentVariantProps & {
    /** 右上角关闭按钮；确认类对话框关掉它，好让初始焦点落在"取消"上。 */
    readonly showClose?: boolean;
  };

export function DialogContent({
  className,
  size,
  showClose = true,
  children,
  ...props
}: DialogContentProps): ReactElement {
  const { t } = useTranslation();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
      <DialogPrimitive.Content
        className={cn(dialogContentVariants({ size }), className)}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              className="absolute top-3 right-3"
              aria-label={t("common.close")}
            >
              <X aria-hidden size={14} />
            </Button>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export interface DialogHeaderProps {
  readonly title: ReactNode;
  /** 一句话说明后果与范围；对话框必须有标题，说明可选。 */
  readonly description?: ReactNode;
  readonly className?: string;
}

/** 对话框头：标题 text-lg font-semibold → 说明 text-sm text-fg-muted（§5.5 结构顺序）。 */
export function DialogHeader({ title, description, className }: DialogHeaderProps): ReactElement {
  return (
    <div className={cn("flex flex-col gap-1 pr-6", className)}>
      <DialogPrimitive.Title className="text-lg font-semibold text-fg">
        {title}
      </DialogPrimitive.Title>
      {description !== undefined ? (
        <DialogPrimitive.Description className="text-sm text-fg-muted">
          {description}
        </DialogPrimitive.Description>
      ) : null}
    </div>
  );
}

export type DialogBodyProps = ComponentPropsWithRef<"div">;

/** 对话框主体：超长内容在此滚动，头尾保持可见。 */
export function DialogBody({ className, ...props }: DialogBodyProps): ReactElement {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto text-sm text-fg", className)} {...props} />
  );
}

export type DialogFooterProps = ComponentPropsWithRef<"div">;

/** 底部操作条：右对齐，取消在左、主操作在右，均为 lg 尺寸（§5.5）。 */
export function DialogFooter({ className, ...props }: DialogFooterProps): ReactElement {
  return <div className={cn("flex items-center justify-end gap-2", className)} {...props} />;
}
