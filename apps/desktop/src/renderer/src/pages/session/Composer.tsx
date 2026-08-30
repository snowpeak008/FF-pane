import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { Textarea } from "../../components/ui/Input";
import { Tooltip } from "../../components/ui/Tooltip";
import { useSessionStore } from "../../stores/session";

/**
 * 会话输入区（W3.4b / §11.2）：底部输入框 + 发送。
 * 草稿存 session UI store（切页不丢，不持久化）。实际发送 = 派发到 Agent 运行时，
 * 依赖 Phase 4 的会话执行链路；此前发送按钮禁用并说明原因（§5.1 tooltip）。
 */
export function Composer(): ReactElement {
  const { t } = useTranslation();
  const draft = useSessionStore((s) => s.composerDraft);
  const setDraft = useSessionStore((s) => s.setComposerDraft);

  return (
    <div className="shrink-0 border-t border-border p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("session.composerPlaceholder")}
          rows={2}
          className="flex-1"
          aria-label={t("session.composerLabel")}
        />
        <Tooltip content={t("session.sendDisabledHint")} wrapTrigger>
          <Button variant="primary" size="md" disabled>
            {t("session.send")}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
