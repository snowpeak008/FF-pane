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
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { PageHeader } from "../../layout/PageHeader";
import { startSessionTurn } from "../../lib/session-run";
import { useSessionStore } from "../../stores/session";
import { NoActiveProject } from "../NoActiveProject";
import { ReviewerBar } from "./ReviewerBar";
import { TaskCard } from "./TaskCard";
import { BOARD_STATUSES, groupTasksByStatus } from "./task-board";
import { deriveTaskReview } from "./task-review";

function TaskBoard({ projectRoot }: { readonly projectRoot: string }): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("tasks:list", { projectRoot });
  // 审查态由 Run 派生（见 task-review），故看板同时要这份列表。
  const { state: runsState, refetch: refetchRuns } = useInvokeQuery("runs:list", { projectRoot });
  const { state: settingsState, refetch: refetchSettings } = useInvokeQuery(
    "projects:get-settings",
    { projectRoot },
  );
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const { profile: workerProfile } = useRoleProfile("worker");
  const navigate = useNavigate();
  // 任一会话轮结束（含 Worker 执行完、审查轮出结论）→ 刷新看板与执行记录。
  const endedTurnSeq = useSessionStore((s) => s.endedTurnSeq);
  useEffect(() => {
    if (endedTurnSeq > 0) {
      refetch();
      refetchRuns();
    }
  }, [endedTurnSeq, refetch, refetchRuns]);

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

  const settings = queryData(settingsState);
  const reviewerEnabled = settings?.reviewerEnabled ?? false;
  const reviewerProfileId = settings?.reviewerProfileId ?? null;
  const runs = queryData(runsState) ?? [];

  const review = useCallback(
    async (task: Task) => {
      if (reviewerProfileId === null) {
        toast.error(t("tasks.reviewer.needBinding"));
        return;
      }
      const latestRun = deriveTaskReview(task, runs).latestRun;
      if (latestRun === undefined) {
        // 按钮本不该在这时可点（canReviewTask 已把关）；数据在点击的一瞬间变旧了才会走到这里。
        toast.error(t("tasks.review.noRun"));
        return;
      }
      const { ack } = await startSessionTurn({
        projectRoot,
        profileId: reviewerProfileId,
        input: { kind: "reviewer-review", taskId: task.id, runId: latestRun.id },
      });
      if (ack === null || !ack.accepted) {
        toast.error(t("tasks.review.startError"), {
          ...(ack !== null && !ack.accepted ? { description: ack.reason } : {}),
        });
        return;
      }
      navigate("/session");
    },
    [projectRoot, reviewerProfileId, runs, navigate, t],
  );

  // Reviewer 开关条常驻在看板之上，含空态与错误态：它是页面级的设置，不该因为
  // "这个项目还没有任务"就消失——那正是用户在开工前顺手把它打开的时候。
  const reviewerBar = (
    <ReviewerBar
      projectRoot={projectRoot}
      enabled={reviewerEnabled}
      profileId={reviewerProfileId}
      onChanged={refetchSettings}
    />
  );

  let board: ReactElement;
  if (state.status === "error") {
    board = (
      <ErrorState
        summary={t("tasks.loadError")}
        error={state.error}
        onRetry={refetch}
        className="min-h-0"
      />
    );
  } else if (state.status !== "success") {
    board = <LoadingState variant="list" />;
  } else if (state.data.length === 0) {
    board = <EmptyState className="min-h-0 flex-1" message={t("tasks.empty")} />;
  } else {
    const groups = groupTasksByStatus(state.data);
    board = (
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
                    review={deriveTaskReview(task, runs)}
                    onAccept={(x) => void runAction("tasks:accept", x)}
                    onCancel={(x) => void runAction("tasks:cancel", x)}
                    onDispatch={(x) => void dispatch(x)}
                    // 未开启 Reviewer 时不传回调 = 卡片上根本没有审查按钮（§3.1 默认关闭）
                    {...(reviewerEnabled ? { onReview: (x: Task) => void review(x) } : {})}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      {reviewerBar}
      {board}
    </>
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
