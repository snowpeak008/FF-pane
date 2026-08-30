import { type ReactElement, type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "./Dialog";
import { isConfirmationSatisfied } from "./dialog.variants";
import { Field, Input } from "./Input";

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 标题写「动作 + 对象」，如"移除项目 foo？"（§5.5）。 */
  readonly title: ReactNode;
  /** 一句话讲清后果与不可逆范围；涉及的数量/路径用 font-mono 强调。 */
  readonly description: ReactNode;
  /** 确认按钮层级：破坏性操作用 danger，不可撤销但非破坏性的用 primary（§6.3）。 */
  readonly tone?: "danger" | "primary";
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /**
   * 超危险档（删除知识库来源、重建索引、清空习惯档案）：
   * 传入对象名后，用户必须逐字输入该名称，否则确认按钮保持 disabled（§5.5）。
   */
  readonly confirmationName?: string;
  /** 确认执行中：按钮进入 loading 并保持尺寸，对话框不自行关闭（由调用方改 open）。 */
  readonly loading?: boolean;
  /** 附加说明区（如受影响文件清单），渲染在说明与输入框之间。 */
  readonly children?: ReactNode;
  readonly onConfirm: () => void;
}

/**
 * 危险操作二次确认（设计系统 §5.5 / 开发计划 §1.5 第 5 条）。
 *
 * 使用边界：**普通操作不要用它**——归档记忆、移除项目、拒绝候选一类可撤销操作
 * 应当立即执行 + 撤销 toast（§6.3）。本组件只服务于不可撤销的操作。
 *
 * 焦点：不渲染右上角关闭按钮，使初始焦点落在"取消"上（超危险档则落在输入框）。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  tone = "danger",
  confirmLabel,
  cancelLabel,
  confirmationName,
  loading = false,
  children,
  onConfirm,
}: ConfirmDialogProps): ReactElement {
  const { t } = useTranslation();
  const inputId = useId();
  const [typed, setTyped] = useState("");

  // 每次打开都从空输入开始，避免上一次的输入残留导致误确认
  useEffect(() => {
    if (open) {
      setTyped("");
    }
  }, [open]);

  const satisfied = isConfirmationSatisfied(confirmationName, typed);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="confirm" showClose={false}>
        <DialogHeader title={title} description={description} />
        {children}
        {confirmationName !== undefined ? (
          <Field
            htmlFor={inputId}
            label={t("common.confirmName.label", { name: confirmationName })}
            hint={t("common.confirmName.hint")}
          >
            <Input
              id={inputId}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
        ) : null}
        <DialogFooter>
          <Button size="lg" variant="secondary" onClick={() => onOpenChange(false)}>
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            size="lg"
            variant={tone}
            loading={loading}
            disabled={!satisfied}
            onClick={onConfirm}
          >
            {confirmLabel ?? t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
