import type { Task } from "@ff-pane/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { TaskStatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";

export interface TaskCardProps {
  readonly task: Task;
  readonly onAccept: (task: Task) => void;
  readonly onCancel: (task: Task) => void;
  /** 派发 Worker 执行（pending = 派发，failed = 重试）。 */
  readonly onDispatch: (task: Task) => void;
  readonly busy: boolean;
}

/**
 * 任务卡片（W3.6 / 设计系统 §5.3 → T4.2 接通派发）。
 * 内容顺序：状态徽章 + 目标（两行截断）→ write_scope（font-mono）→ 操作按钮组。
 * dispatch 仅 pending/failed 可用（failed 显示为重试）；accept 仅 done 态；
 * cancel 仅未派发/阻塞/失败态。
 */
export function TaskCard({
  task,
  onAccept,
  onCancel,
  onDispatch,
  busy,
}: TaskCardProps): ReactElement {
  const { t } = useTranslation();
  const canAccept = task.status === "done";
  const canDispatch = task.status === "pending" || task.status === "failed";
  const canCancel =
    task.status === "pending" || task.status === "blocked" || task.status === "failed";

  return (
    <Card padding="compact" className="flex flex-col gap-2">
      <TaskStatusBadge status={task.status} className="self-start" />
      <p className="line-clamp-2 text-sm font-medium text-fg" title={task.goal}>
        {task.goal}
      </p>
      {task.writeScope.length > 0 ? (
        <p className="truncate font-mono text-xs text-fg-muted" title={task.writeScope.join("\n")}>
          {task.writeScope.join(", ")}
        </p>
      ) : null}
      {canAccept || canCancel || canDispatch ? (
        <div className="flex items-center gap-1 pt-0.5">
          {canDispatch ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onDispatch(task)}>
              {task.status === "failed" ? t("tasks.retry") : t("tasks.dispatch")}
            </Button>
          ) : null}
          {canAccept ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onAccept(task)}>
              {t("tasks.accept")}
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
