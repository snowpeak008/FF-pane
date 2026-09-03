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
import {
  ActiveTurnsSection,
  DispatchConflictNotice,
  type DispatchConflictState,
} from "./ActiveTurnsSection";
import { ReviewerBar } from "./ReviewerBar";
import { TaskCard } from "./TaskCard";
import { BOARD_STATUSES, groupTasksByStatus } from "./task-board";
import { deriveTaskReview } from "./task-review";

/**
 * 任务看板（T8.3b 增补并行呈现）。
 *
 * 排队 vs 「等待后重试」的取舍（工单允许自选，两案对比落档）：
 * - 案 A（选定）被拒即止 + 常驻冲突提示 + 手动重试：被拒的派发不产生任何持久状态
 *   （任务保持 pending/failed，编排器裁决通过前连 dispatchTask 都不发生），用户看着
 *   在飞区判断"什么时候能派"，相交轮结束后点重试。语义与现状一致：派发从来是
 *   显式用户动作，失败原因当场可读。
 * - 案 B 轻量排队（被拒任务挂队列、相交轮结束自动派发）：要新增队列状态（存哪？
 *   渲染层内存态会因刷新丢失、持久化则引入新的启动修正义务）、要回答"排队期间任务
 *   改了/取消了怎么办"、自动派发还会在用户不在场时启动要花钱的 Agent 轮——复杂度
 *   与「用户自己点一下重试」的成本完全不成比例，弃。
 */
function TaskBoard({ projectRoot }: { readonly projectRoot: string }): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("tasks:list", { projectRoot });
  // 审查态由 Run 派生（见 task-review），故看板同时要这份列表。
  const { state: runsState, refetch: refetchRuns } = useInvokeQuery("runs:list", { projectRoot });
  const { state: settingsState, refetch: refetchSettings } = useInvokeQuery(
    "projects:get-settings",
    { projectRoot },
  );
  // 在飞轮次区（T8.3b）：纯内存快照，挂载即取；轮的启停经下方两个 effect 触发重取。
  const { state: activeTurnsState, refetch: refetchActiveTurns } = useInvokeQuery(
    "sessions:active-turns",
    { projectRoot },
  );
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [dispatchConflict, setDispatchConflict] = useState<DispatchConflictState | null>(null);
  const { profile: workerProfile } = useRoleProfile("worker");
  const navigate = useNavigate();
  // 任一会话轮结束（含 Worker 执行完、审查轮出结论）→ 刷新看板、执行记录与在飞区。
  const endedTurnSeq = useSessionStore((s) => s.endedTurnSeq);
  useEffect(() => {
    if (endedTurnSeq > 0) {
      refetch();
      refetchRuns();
      refetchActiveTurns();
    }
  }, [endedTurnSeq, refetch, refetchRuns, refetchActiveTurns]);
  // 渲染层已知的在飞轮数变化（本页派发 / 会话页发起）→ 在飞区跟着刷。
  // store 的 Map 是跨会话全量，size 变化即有轮启停；主进程快照才是事实源，这里只当触发器。
  const knownTurnCount = useSessionStore((s) => s.activeTurns.size);
  // biome-ignore lint/correctness/useExhaustiveDependencies: knownTurnCount 是刻意的触发器依赖——轮启停即重取主进程快照
  useEffect(() => {
    refetchActiveTurns();
  }, [knownTurnCount, refetchActiveTurns]);

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
        // 并行互斥拒绝（T8.3b）：结构化明细进常驻提示条（与哪个在飞任务、哪两条
        // 路径、何种相交 + 重试入口），一条 toast 装不下也留不住。其他拒绝维持 toast。
        if (ack !== null && !ack.accepted && ack.conflicts !== undefined) {
          setDispatchConflict({ taskId: task.id, conflicts: ack.conflicts });
          refetchActiveTurns();
          return;
        }
        toast.error(t("tasks.dispatchError"), {
          ...(ack !== null && !ack.accepted ? { description: ack.reason } : {}),
        });
        return;
      }
      setDispatchConflict((prev) => (prev?.taskId === task.id ? null : prev));
      refetch();
      refetchActiveTurns();
      // 导航到会话页跟进流式执行与权限审批（§12 派发即进入执行视图）。
      navigate("/session");
    },
    [projectRoot, workerProfile, navigate, refetch, refetchActiveTurns, t],
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

  // 在飞区数据：查询失败按空处理（并行呈现是增强，不该让看板跟着报错——
  // 快照纯内存、失败仅意味着主进程未就绪，下次触发器重取即恢复）
  const activeTurns = queryData(activeTurnsState) ?? [];

  return (
    <>
      {reviewerBar}
      <ActiveTurnsSection turns={activeTurns} />
      {dispatchConflict !== null ? (
        <DispatchConflictNotice
          conflict={dispatchConflict}
          onRetry={() => {
            const task = queryData(state)?.find((x) => x.id === dispatchConflict.taskId);
            if (task !== undefined) {
              void dispatch(task);
              return;
            }
            // 任务已不在列表（被取消/接受）：冲突提示失去对象，收掉即可
            setDispatchConflict(null);
          }}
          onDismiss={() => setDispatchConflict(null)}
        />
      ) : null}
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
