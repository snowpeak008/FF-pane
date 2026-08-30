import type { KeyboardEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { Textarea } from "../../components/ui/Input";
import { Tooltip } from "../../components/ui/Tooltip";
import { useSessionStore } from "../../stores/session";

export interface ComposerProps {
  /** 发送草稿（非空时调用；发送后由本组件清空草稿）。 */
  readonly onSend: (text: string) => void;
  /** 是否禁用发送（在飞轮 / 无可用 Profile 等）。 */
  readonly disabled: boolean;
  /** 禁用原因（有则以 tooltip 呈现，§5.1）。 */
  readonly disabledReason?: string;
}

/**
 * 会话输入区（W3.4b / §11.2）：底部输入框 + 发送。草稿存 session UI store（切页不丢）。
 * T4.2 接通：发送 = 发起一轮 Planner 讨论（session:start），增量经全局桥流式喂入。
 * Enter 发送、Shift+Enter 换行。
 */
export function Composer({ onSend, disabled, disabledReason }: ComposerProps): ReactElement {
  const { t } = useTranslation();
  const draft = useSessionStore((s) => s.composerDraft);
  const setDraft = useSessionStore((s) => s.setComposerDraft);
  const clearDraft = useSessionStore((s) => s.clearComposerDraft);

  const canSend = !disabled && draft.trim().length > 0;

  const send = (): void => {
    if (!canSend) {
      return;
    }
    onSend(draft.trim());
    clearDraft();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const button = (
    <Button variant="primary" size="md" disabled={!canSend} onClick={send}>
      {t("session.send")}
    </Button>
  );

  return (
    <div className="shrink-0 border-t border-border p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("session.composerPlaceholder")}
          rows={2}
          className="flex-1"
          aria-label={t("session.composerLabel")}
        />
        {disabled && disabledReason !== undefined ? (
          <Tooltip content={disabledReason} wrapTrigger>
            {button}
          </Tooltip>
        ) : (
          button
        )}
      </div>
    </div>
  );
}
