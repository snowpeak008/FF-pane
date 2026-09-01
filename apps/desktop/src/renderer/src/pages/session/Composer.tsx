import { BookOpen } from "lucide-react";
import { type KeyboardEvent, type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCommandHandler, useShortcutScope } from "../../command";
import { Button } from "../../components/ui/Button";
import { Textarea } from "../../components/ui/Input";
import { Tooltip } from "../../components/ui/Tooltip";
import { useSessionStore } from "../../stores/session";
import { KnowledgeInsertDialog } from "./KnowledgeInsertDialog";

export interface ComposerProps {
  /**
   * 发送草稿（非空时调用；发送后由本组件清空草稿）。
   * directExecute（T5.3 习惯先行，§8.2.3）：本轮「直接做」，跳过据 workflow 流程约束的整形。
   */
  readonly onSend: (text: string, directExecute: boolean) => void;
  /**
   * 生成计划（T4.6，§12「出计划」）：据当前讨论让 Planner 产出结构化计划草案。
   * 不依赖草稿（用会话上下文）；提供则渲染次按钮。
   */
  readonly onGeneratePlan?: () => void;
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
export function Composer({
  onSend,
  onGeneratePlan,
  disabled,
  disabledReason,
}: ComposerProps): ReactElement {
  const { t } = useTranslation();
  const draft = useSessionStore((s) => s.composerDraft);
  const setDraft = useSessionStore((s) => s.setComposerDraft);
  const clearDraft = useSessionStore((s) => s.clearComposerDraft);
  // 习惯先行「直接做」是单次意图，随发送重置——存本地 UI 态即可（不进 store）。
  const [directExecute, setDirectExecute] = useState(false);
  // 「从知识库插入」（T6.5 / §8.3.5）：插入的是引用文本，与发送与否无关，故只管开合
  const [insertOpen, setInsertOpen] = useState(false);
  // 输入框是否有焦点：决定 session-input 作用域是否激活（见下方接线）
  const [inputFocused, setInputFocused] = useState(false);

  const canSend = !disabled && draft.trim().length > 0;

  const send = (): void => {
    if (!canSend) {
      return;
    }
    onSend(draft.trim(), directExecute);
    clearDraft();
    setDirectExecute(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  // 命令面板接线（T8.1）。两个动作的状态都住在本组件里（对话框开合、草稿与可发送判定），
  // 挂载方拿不到，故由本组件自报而不是走 Provider 的 handlers prop。
  // 作用域上报是键位生效的前提——未上报的作用域内键位不触发（§7）。
  // session 只要输入区在场即激活；session-input 按 §7 的字面意思只在输入框有焦点时激活
  // （Ctrl+Enter 在任务页是「派发任务」，焦点不在这儿时不该被会话页抢走）。
  useShortcutScope("session");
  useShortcutScope("session-input", inputFocused);
  useCommandHandler("session-insert-knowledge", () => setInsertOpen(true));
  useCommandHandler("session-send", send);

  const button = (
    <Button variant="primary" size="md" disabled={!canSend} onClick={send}>
      {t("session.send")}
    </Button>
  );

  return (
    <div className="shrink-0 border-t border-border p-3">
      <div className="mx-auto mb-1.5 flex max-w-3xl items-center justify-between gap-2">
        <Tooltip content={t("session.directExecuteHint")} wrapTrigger>
          <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-fg-muted">
            <input
              type="checkbox"
              checked={directExecute}
              onChange={(e) => setDirectExecute(e.target.checked)}
            />
            {t("session.directExecute")}
          </label>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={() => setInsertOpen(true)}>
          <BookOpen aria-hidden size={14} />
          {t("knowledge.insertFromKnowledge")}
        </Button>
      </div>
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          placeholder={t("session.composerPlaceholder")}
          rows={2}
          className="flex-1"
          aria-label={t("session.composerLabel")}
        />
        {onGeneratePlan !== undefined ? (
          <Button
            variant="secondary"
            size="md"
            disabled={disabled}
            onClick={onGeneratePlan}
            className="shrink-0"
          >
            {t("session.generatePlan")}
          </Button>
        ) : null}
        {disabled && disabledReason !== undefined ? (
          <Tooltip content={disabledReason} wrapTrigger>
            {button}
          </Tooltip>
        ) : (
          button
        )}
      </div>
      {/* 对话框内的检索在打开时才发起（组件挂载即拉），关闭即卸载，不驻留订阅 */}
      {insertOpen ? <KnowledgeInsertDialog open onOpenChange={setInsertOpen} /> : null}
    </div>
  );
}
