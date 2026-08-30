import type { Task } from "@ff-pane/shared";
import { type ReactElement, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import { LoadingState } from "../../components/states/LoadingState";
import { useActiveProject } from "../../hooks/useActiveProject";
import { invokeQuery } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { PageHeader } from "../../layout/PageHeader";
import { NoActiveProject } from "../NoActiveProject";
import { TaskCard } from "./TaskCard";
import { BOARD_STATUSES, groupTasksByStatus } from "./task-board";

function TaskBoard({ projectRoot }: { readonly projectRoot: string }): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("tasks:list", { projectRoot });
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const runAction = useCallback(
    async (channel: "tasks:accept" | "tasks:cancel", task: Task) => {
      setBusyIds((prev) => new Set(prev).add(task.id));
      const settled = await invokeQuery(channel, { projectRoot, id: task.id });
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
      if (settled.status === "error") {
        toast.error(t("tasks.actionError"), { description: settled.error.message });
        return;
      }
      refetch();
      toast.success(channel === "tasks:accept" ? t("tasks.accepted") : t("tasks.cancelled"));
    },
    [projectRoot, refetch, t],
  );

  if (state.status === "error") {
    return (
      <ErrorState
        summary={t("tasks.loadError")}
        error={state.error}
        onRetry={refetch}
        className="min-h-0"
      />
    );
  }
  if (state.status !== "success") {
    return <LoadingState variant="list" />;
  }
  if (state.data.length === 0) {
    return <EmptyState className="min-h-0 flex-1" message={t("tasks.empty")} />;
  }

  const groups = groupTasksByStatus(state.data);
  return (
    <div className="min-h-0 flex-1 overflow-x-auto">
      <div className="flex h-full gap-3 p-4">
        {BOARD_STATUSES.map((status) => (
          <div key={status} className="flex w-72 shrink-0 flex-col gap-2">
            <div className="flex items-center gap-2 px-1">
              <span className="text-xs font-medium text-fg">{t(`task.status.${status}`)}</span>
              <span className="text-xs text-fg-subtle">{groups[status].length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {groups[status].map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  busy={busyIds.has(task.id)}
                  onAccept={(x) => void runAction("tasks:accept", x)}
                  onCancel={(x) => void runAction("tasks:cancel", x)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 任务页（W3.6 / §11.4「现在做到哪了」）：六状态看板 + 任务卡片。
 * 以当前项目为作用域；任务由 Planner 批准计划后生成（Phase 4），此前显示空态。
 */
export function TasksPage(): ReactElement {
  const { t } = useTranslation();
  const { entry, loading } = useActiveProject();

  return (
    <>
      <PageHeader title={t("nav.tasks.label")} description={t("nav.tasks.question")} />
      {loading ? (
        <LoadingState variant="list" />
      ) : entry === null ? (
        <NoActiveProject />
      ) : (
        <TaskBoard projectRoot={entry.rootPath} />
      )}
    </>
  );
}
