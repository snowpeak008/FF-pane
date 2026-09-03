import { MessageSquarePlus } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { sessionBusy, useSessionStore } from "../../stores/session";

/**
 * 续接横幅（T8.2b-b，§10.3）：自动选中最近会话并回放后，消息区顶部说明
 * 「已续接上次会话 · 原生恢复 / 上下文重建」+「新建会话」按钮。
 *
 * 与 SessionResumePanel 的关系：双入口保留——横幅回答"当前这份回放是哪来的、
 * 怎么续"，恢复列表回答"还有哪些别的会话可切"；两者的方式预判共用
 * resume-view.ts 的同一份纯函数（predictedKind 在 loadReplay 时算好存进 store）。
 *
 * 只在 replay 上下文仍指向当前会话时渲染：用户从恢复列表切到别的会话、或点了
 * 新建会话之后，这份"已续接"的说明就不再属实。
 */
export function SessionReplayBanner(): ReactElement | null {
  const { t } = useTranslation();
  const replay = useSessionStore((s) => s.replay);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeTurns = useSessionStore((s) => s.activeTurns);
  const startNewSession = useSessionStore((s) => s.startNewSession);

  if (replay === null || replay.sessionId !== activeSessionId) {
    return null;
  }

  // 本会话有在飞轮时禁用（T8.3b busy 语义）：startNewSession 会切走当前视图，
  // 正在输出的轮不该被"新建"悄悄藏起；别的会话的并发轮不受影响、也不影响此按钮
  const busy = sessionBusy(activeTurns, activeSessionId);

  return (
    <div className="shrink-0 border-b border-border bg-surface-sunken px-4 py-2">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <span className="text-xs text-fg-muted">
          {t("session.replay.banner", { kind: t(`session.resumeKind.${replay.predictedKind}`) })}
        </span>
        <div className="ml-auto">
          <Button variant="ghost" size="sm" disabled={busy} onClick={startNewSession}>
            <MessageSquarePlus aria-hidden size={14} />
            {t("session.replay.newSession")}
          </Button>
        </div>
      </div>
    </div>
  );
}
