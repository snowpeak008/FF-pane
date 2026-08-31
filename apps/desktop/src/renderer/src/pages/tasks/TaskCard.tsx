import type { ReviewVerdict, Task } from "@ff-pane/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Badge, TaskStatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { cn } from "../../lib/cn";
import { canReviewTask, type TaskReviewState } from "./task-review";

/** 结论 → 徽章配色。inconclusive 用中性色：它不是坏消息，是"没得出结论"。 */
const VERDICT_CLASS: Readonly<Record<ReviewVerdict, string>> = {
  pass: "bg-success-surface text-success-text",
  fail: "bg-danger-surface text-danger-text",
  inconclusive: "bg-surface-sunken text-fg-muted",
};

export interface TaskCardProps {
  readonly task: Task;
  readonly onAccept: (task: Task) => void;
  readonly onCancel: (task: Task) => void;
  /** 派发 Worker 执行（pending = 派发，failed = 重试）。 */
  readonly onDispatch: (task: Task) => void;
  /**
   * 发起一次审查（T7.2）。缺省 = 本项目未开启 Reviewer，审查按钮整个不渲染
   * （§3.1「可选，默认关闭」：关着的时候用户不该看见一个自己没开的角色）。
   */
  readonly onReview?: (task: Task) => void;
  /** 该任务的审查态（由 runs 派生，见 task-review）。 */
  readonly review?: TaskReviewState;
  readonly busy: boolean;
}

/**
 * 任务卡片（W3.6 / 设计系统 §5.3 → T4.2 接通派发 → T7.2 接通审查）。
 * 内容顺序：状态徽章 + 审查结论徽章 + 目标（两行截断）→ write_scope（font-mono）→ 操作按钮组。
 * dispatch 仅 pending/failed 可用（failed 显示为重试）；accept 仅 done 态；
 * cancel 仅未派发/阻塞/失败态；review 仅 done 且已有执行记录时（且项目开了 Reviewer）。
 */
export function TaskCard({
  task,
  onAccept,
  onCancel,
  onDispatch,
  onReview,
  review,
  busy,
}: TaskCardProps): ReactElement {
  const { t } = useTranslation();
  const canAccept = task.status === "done";
  const canDispatch = task.status === "pending" || task.status === "failed";
  const canCancel =
    task.status === "pending" || task.status === "blocked" || task.status === "failed";
  const reviewState = review ?? {};
  const canReview = onReview !== undefined && canReviewTask(task, reviewState);
  const verdict = reviewState.verdict;
  // 审查不通过时接受键降级为次要，但**仍可点**：§6.3 的 done ≠ accepted 是双向的——
  // Reviewer 说不行也不能替用户否决，它只是一份摆在按钮旁边的参考意见。
  const acceptVariant = verdict === "fail" ? "secondary" : "primary";

  return (
    <Card padding="compact" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        <TaskStatusBadge status={task.status} />
        {verdict !== undefined ? (
          <Badge
            tone="unstyled"
            className={cn("border-transparent", VERDICT_CLASS[verdict])}
            title={t(`tasks.review.verdictHint.${verdict}`)}
          >
            {t(`tasks.review.verdict.${verdict}`)}
          </Badge>
        ) : null}
      </div>
      <p className="line-clamp-2 text-sm font-medium text-fg" title={task.goal}>
        {task.goal}
      </p>
      {task.writeScope.length > 0 ? (
        <p className="truncate font-mono text-xs text-fg-muted" title={task.writeScope.join("\n")}>
          {task.writeScope.join(", ")}
        </p>
      ) : null}
      {/* 不通过时给一行提示，说明这不构成否决——否则一个红徽章旁边的可点按钮会让人以为是 bug。 */}
      {verdict === "fail" ? (
        <p className="text-2xs text-fg-subtle">{t("tasks.review.failNote")}</p>
      ) : null}
      {canAccept || canCancel || canDispatch || canReview ? (
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          {canDispatch ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onDispatch(task)}>
              {task.status === "failed" ? t("tasks.retry") : t("tasks.dispatch")}
            </Button>
          ) : null}
          {canAccept ? (
            <Button
              variant={acceptVariant}
              size="sm"
              disabled={busy}
              onClick={() => onAccept(task)}
            >
              {t("tasks.accept")}
            </Button>
          ) : null}
          {canReview ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onReview(task)}>
              {verdict === undefined ? t("tasks.review.start") : t("tasks.review.again")}
            </Button>
          ) : null}
          {canCancel ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onCancel(task)}>
              {t("tasks.cancel")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
