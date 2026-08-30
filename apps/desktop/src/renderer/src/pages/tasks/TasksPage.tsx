import type { Task } from "@ff-pane/shared";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import { LoadingState } from "../../components/states/LoadingState";
import { useActiveProject } from "../../hooks/useActiveProject";
import { useRoleProfile } from "../../hooks/useRoleProfile";
import { invokeQuery } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { PageHeader } from "../../layout/PageHeader";
import { startSessionTurn } from "../../lib/session-run";
import { useSessionStore } from "../../stores/session";
import { NoActiveProject } from "../NoActiveProject";
import { TaskCard } from "./TaskCard";
import { BOARD_STATUSES, groupTasksByStatus } from "./task-board";

function TaskBoard({ projectRoot }: { readonly projectRoot: string }): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("tasks:list", { projectRoot });
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const { profile: workerProfile } = useRoleProfile("worker");
  const navigate = useNavigate();
  // 任一会话轮结束（含 Worker 执行完）→ 刷新看板，反映新状态（done/failed）。
  const endedTurnSeq = useSessionStore((s) => s.endedTurnSeq);
  useEffect(() => {
    if (endedTurnSeq > 0) {
      refetch();
    }
  }, [endedTurnSeq, refetch]);

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
      if (channel === "tasks:cancel") {
        toast.success(t("tasks.cancelled"));
        return;
      }
      // T4.4：验收提示带记忆候选汇总（不弹窗打断，候选角标见记忆页候选标签）。
      const count = "candidateCount" in settled.data ? settled.data.candidateCount : 0;
      toast.success(t("tasks.accepted"), {
        ...(count > 0 ? { description: t("tasks.candidatesGenerated", { count }) } : {}),
      });
    },
    [projectRoot, refetch, t],
  );

  const dispatch = useCallback(
    async (task: Task) => {
      if (workerProfile === null) {
        toast.error(t("tasks.noWorkerProfile"));
        return;
      }
      const { ack } = await startSessionTurn({
        projectRoot,
        profileId: workerProfile.id,
        input: { kind: "worker-task", taskId: task.id },
      });
      if (ack === null || !ack.accepted) {
        toast.error(t("tasks.dispatchError"), {
          ...(ack !== null && !ack.accepted ? { description: ack.reason } : {}),
        });
        return;
      }
      refetch();
      // 导航到会话页跟进流式执行与权限审批（§12 派发即进入执行视图）。
      navigate("/session");
    },
    [projectRoot, workerProfile, navigate, refetch, t],
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
                  onDispatch={(x) => void dispatch(x)}
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
