import type { ActiveTurnRecord, WritePathsConflict } from "@ff-pane/core";
import { X } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useRoleLabel } from "../../hooks/useRoleLabel";
import { formatRelativeTime } from "../../lib/time";

export interface ActiveTurnsSectionProps {
  /** 当前项目的在飞轮次（sessions:active-turns 快照，startedAt 升序）。 */
  readonly turns: readonly ActiveTurnRecord[];
}

/**
 * 在飞轮次区（T8.3b，§16.4「哪些在飞」）：消费 sessions:active-turns 的纯内存快照，
 * 逐轮列出 角色 · 关联任务 · 开始时间 · 占用的可写范围。可写范围直接决定并行裁决
 * （相交即拒绝派发），故它不是调试信息而是用户判断「还能派什么」的依据。
 * 无在飞轮时整个区不渲染——空的"在飞区"只是噪声，看板本身就是常态视图。
 */
export function ActiveTurnsSection({ turns }: ActiveTurnsSectionProps): ReactElement | null {
  const { t, i18n } = useTranslation();
  const roleLabel = useRoleLabel();
  if (turns.length === 0) {
    return null;
  }
  return (
    <div className="shrink-0 border-b border-border bg-surface-sunken px-4 py-2">
      <span className="text-xs font-medium text-fg">{t("tasks.parallel.activeTitle")}</span>
      <div className="mt-1.5 flex flex-col gap-1">
        {turns.map((turn) => (
          <div key={turn.turnId} className="flex flex-wrap items-center gap-2 text-xs">
            <Badge>{roleLabel(turn.role)}</Badge>
            {turn.taskId !== undefined ? (
              <span className="font-mono text-fg-muted">{turn.taskId}</span>
            ) : null}
            <span className="text-fg-subtle">
              {t("tasks.parallel.startedAt", {
                time: formatRelativeTime(turn.startedAt, i18n.language),
              })}
            </span>
            {turn.writePaths.length > 0 ? (
              <span className="truncate font-mono text-fg-muted" title={turn.writePaths.join("\n")}>
                {t("tasks.parallel.writes", { paths: turn.writePaths.join(", ") })}
              </span>
            ) : (
              <span className="text-fg-subtle">{t("tasks.parallel.readOnly")}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 一次被拒派发的现场（呈现在看板顶部，直到用户关掉或重派成功）。 */
export interface DispatchConflictState {
  /** 被拒的任务。 */
  readonly taskId: string;
  /** 结构化相交明细（StartSessionAck.conflicts）。 */
  readonly conflicts: readonly WritePathsConflict[];
}

export interface DispatchConflictNoticeProps {
  readonly conflict: DispatchConflictState;
  /** 重试派发（等相交的在飞轮结束后自然路径）。 */
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}

/**
 * 派发冲突提示（T8.3b，§16.4「哪些因相交被拒绝并行及原因」）：明细按结构化字段
 * 本地化渲染（哪个在飞任务、哪两条路径、何种相交）——不用 core 生成的 reason 原文，
 * 双语言界面下明细才跟着语言走。「等待后重试」是自然路径：面板常驻到用户关掉或
 * 重派成功，相交的在飞轮结束后点重试即可；不做排队（对比见任务页头注）。
 */
export function DispatchConflictNotice({
  conflict,
  onRetry,
  onDismiss,
}: DispatchConflictNoticeProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 border-b border-border bg-surface-sunken px-4 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg">
            {t("tasks.parallel.rejectedTitle", { taskId: conflict.taskId })}
          </span>
          {conflict.conflicts.map((item) => (
            <span
              key={`${item.inflightId}:${item.candidatePath}:${item.inflightPath}`}
              className="text-xs text-fg-muted"
            >
              {t("tasks.parallel.conflictLine", {
                candidatePath: item.candidatePath,
                inflightId: item.inflightId,
                inflightPath: item.inflightPath,
                relation: t(`tasks.parallel.relation.${item.relation}`),
              })}
            </span>
          ))}
          <span className="text-xs text-fg-subtle">{t("tasks.parallel.retryHint")}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t("tasks.parallel.retry")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onDismiss}
          >
            <X aria-hidden size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}
