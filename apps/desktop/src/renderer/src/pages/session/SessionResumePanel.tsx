import type { LocalSessionId, SessionRecord } from "@ff-pane/shared";
import { RotateCcw } from "lucide-react";
import { type ReactElement, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { formatRelativeTime } from "../../lib/time";
import { useSessionStore } from "../../stores/session";
import { predictResumeKind } from "./resume-view";

export interface SessionResumePanelProps {
  readonly projectRoot: string;
  /** 当前已选为续接目标的会话（高亮标注）。 */
  readonly activeSessionId: LocalSessionId | null;
  /** 选中一条历史会话作为续接目标（下一次发言即触发原生恢复 / 上下文重建）。 */
  readonly onResume: (session: SessionRecord) => void;
  readonly disabled: boolean;
}

/**
 * 会话恢复列表（T4.3，§10.3）：列出当前项目已登记的历史会话，供重启后续接。
 *
 * 每条给出角色 · 最近活跃 · 可恢复方式预判（有原生绑定→原生恢复，否则→上下文重建），
 * 「续接」按钮把该会话设为当前会话；随后在输入区发言即以该方式续接。会话登记（不含
 * 会话正文）由编排器在每轮维护，故重启应用后本列表仍在——这是 §10.3 恢复的入口。
 *
 * 无历史会话时整块隐藏（返回 null）：新项目没有可恢复的会话，不该占据版面。
 */
export function SessionResumePanel({
  projectRoot,
  activeSessionId,
  onResume,
  disabled,
}: SessionResumePanelProps): ReactElement | null {
  const { t, i18n } = useTranslation();
  const { state, refetch } = useInvokeQuery("sessions:list", { projectRoot });
  // 任一会话轮结束即刷新：新登记 / 更新的会话及时进入可恢复列表。
  const endedTurnSeq = useSessionStore((s) => s.endedTurnSeq);
  useEffect(() => {
    if (endedTurnSeq > 0) {
      refetch();
    }
  }, [endedTurnSeq, refetch]);

  if (state.status !== "success" || state.data.length === 0) {
    return null;
  }

  return (
    <div className="shrink-0 border-b border-border bg-surface-sunken px-4 py-2">
      <div className="mx-auto max-w-3xl">
        <p className="mb-1.5 text-[11px] font-medium text-fg-muted">{t("session.resume.title")}</p>
        <ul className="flex flex-col gap-1">
          {state.data.map((session) => {
            const isActive = session.id === activeSessionId;
            // 预判逻辑唯一来源：resume-view.ts（续接横幅共用同一份，T8.2b-b）
            const kindKey = predictResumeKind(session);
            return (
              <li
                key={session.id}
                className="flex items-center gap-2 rounded border border-border bg-surface px-2 py-1 text-xs"
              >
                <span className="text-fg-muted">{t(`session.role.${session.role}`)}</span>
                <span
                  className="text-fg-subtle"
                  title={new Date(session.lastActiveAt).toLocaleString(i18n.language)}
                >
                  {formatRelativeTime(session.lastActiveAt, i18n.language)}
                </span>
                <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-fg-subtle">
                  {t(`session.resume.willUse.${kindKey}`)}
                </span>
                <div className="ml-auto">
                  {isActive ? (
                    <span className="text-[11px] text-fg-muted">
                      {t("session.resume.selected")}
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => onResume(session)}
                    >
                      <RotateCcw className="size-3" />
                      {t("session.resume.action")}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
