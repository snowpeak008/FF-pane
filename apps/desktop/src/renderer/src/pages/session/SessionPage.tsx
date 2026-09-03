import type { SessionRecord } from "@ff-pane/shared";
import { ArrowLeftRight } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { LoadingState } from "../../components/states/LoadingState";
import { Button } from "../../components/ui/Button";
import { useActiveProject } from "../../hooks/useActiveProject";
import { useDiscussionProfiles } from "../../hooks/useRoleProfile";
import { invokeQuery } from "../../ipc/query";
import { PageHeader } from "../../layout/PageHeader";
import { cancelSessionTurn, startSessionTurn } from "../../lib/session-run";
import { currentSessionTurns, sessionStatusView, useSessionStore } from "../../stores/session";
import { NoActiveProject } from "../NoActiveProject";
import type { ChatMessageView } from "./ChatMessage";
import { Composer } from "./Composer";
import { HandoffDialog } from "./HandoffDialog";
import { MessageStream } from "./MessageStream";
import { PermissionBanner } from "./PermissionBanner";
import { predictResumeKind } from "./resume-view";
import { SessionReplayBanner } from "./SessionReplayBanner";
import { SessionResumePanel } from "./SessionResumePanel";
import { SessionStatusBar } from "./SessionStatusBar";
import { mapTranscriptToMessages } from "./transcript-view";

/**
 * 回放一条会话：读其回放本尾部 → 映射为历史消息 → 载入 store（含横幅上下文）。
 * 自动续接 effect 与恢复列表的「续接」共用（选中即看到那份对话，不是只改个目标 ID）。
 * 读失败返回 false，调用方决定是否提示（自动路径静默保持空态，不打扰）。
 */
async function replaySession(projectRoot: string, session: SessionRecord): Promise<boolean> {
  const transcript = await invokeQuery("sessions:transcript", {
    projectRoot,
    sessionId: session.id,
  });
  if (transcript.status === "error") {
    return false;
  }
  useSessionStore.getState().loadReplay({
    projectRoot,
    replay: {
      sessionId: session.id,
      predictedKind: predictResumeKind(session),
      skippedLines: transcript.data.skippedLines,
    },
    messages: mapTranscriptToMessages(transcript.data.entries),
  });
  return true;
}

/**
 * 会话页（W3.4 / §11.2「我正在和谁讨论什么」）：状态条 + 消息流 + 权限横幅 + 输入区。
 *
 * 以当前项目为作用域。消息有两个来源（T8.2b-b）：历史消息（transcript 回放 + 已结束轮
 * 的固化，session store 的 historyMessages）与在飞轮的流式缓存（activeTurns，由全局
 * SessionEventBridge 唯一订阅喂入）。进入页面时若无在飞轮，自动经 sessions:latest 选中
 * 最近会话并回放其回放本（§10.2 规则 3 修订版）；被中断轮次显式标注。
 * T4.2 接通：输入区发送 = 发起一轮 Planner 讨论；任务页派发的 Worker 轮亦在此呈现与审批。
 *
 * 多轮并发（T8.3b）：本页仍是**单会话视图**——只渲染当前会话的在飞轮，多条在飞轮按
 * 开始序追加在历史之后（时间序交错：各轮的用户输入在发起时已按序进历史，其 assistant
 * 流式条目跟在后面；不做按轮分组——单会话内并发轮极少见（Composer 在飞即禁发），
 * 为它引入分组容器只会让常态的单轮阅读多一层框）。busy = 当前会话有在飞轮
 * （sessionBusy）：别的会话的并发 Worker 轮不锁本会话的输入。权限横幅跨会话列出
 * 全部待批请求（PermissionBanner 注释）。
 */
export function SessionPage(): ReactElement {
  const { t } = useTranslation();
  const { entry, loading } = useActiveProject();
  // 讨论轮 Profile（T8.4）：planner 与自定义角色 Profile 都可承载讨论；多个可选时
  // 状态条给下拉。缺省取第一个 planner Profile（与 T8.4 前行为一致），否则取列表首个。
  const { profiles: discussionProfiles, loading: profileLoading } = useDiscussionProfiles();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const activeProfile =
    discussionProfiles.find((p) => p.id === selectedProfileId) ??
    discussionProfiles.find((p) => p.defaultRole === "planner") ??
    discussionProfiles[0] ??
    null;
  // 发起时的本地角色回显：自定义角色 Profile 传其角色 ID（权威值仍是 started.role）
  const localRole =
    activeProfile !== null && activeProfile.defaultRole !== "planner"
      ? activeProfile.defaultRole
      : undefined;

  const navigate = useNavigate();
  const activeTurns = useSessionStore((s) => s.activeTurns);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const endedTurnSeq = useSessionStore((s) => s.endedTurnSeq);
  const lastEndedTurn = useSessionStore((s) => s.lastEndedTurn);
  const historyMessages = useSessionStore((s) => s.historyMessages);
  const replay = useSessionStore((s) => s.replay);
  const autoResumeDoneRoot = useSessionStore((s) => s.autoResumeDoneRoot);
  const lastEndedView = useSessionStore((s) => s.lastEndedView);
  const [cancelling, setCancelling] = useState(false);
  // 跨 Agent 迁移（T7.1，§10.4）：对话框只在打开时挂载——交接包是"此刻的项目现状"快照，
  // 常驻会让它在项目推进后悄悄过期。
  const [handoffOpen, setHandoffOpen] = useState(false);

  // 自动续接（T8.2b-b）：进入会话页且该项目尚未处理过时，取最近会话并回放其对话。
  // 无历史会话时只记「已处理」保持空态。in-flight 守卫（loadReplay 内亦有）：用户已在
  // 聊的现场绝不被回放覆盖。effect 期间响应到达时以 store 最新态为准（getState），
  // 避免闭包里的陈旧在飞表。
  const projectRoot = entry?.rootPath ?? null;
  useEffect(() => {
    if (projectRoot === null || autoResumeDoneRoot === projectRoot) {
      return;
    }
    if (useSessionStore.getState().activeTurns.size > 0) {
      return;
    }
    // 先清掉上一个项目残留的会话态（历史消息 / 横幅 / 当前会话都是项目级的），
    // 再决定本项目回放什么——否则切到无会话的项目会看到上个项目的对话。
    useSessionStore.getState().startNewSession();
    let stale = false;
    void (async () => {
      const latest = await invokeQuery("sessions:latest", { projectRoot });
      if (stale || latest.status === "error") {
        return;
      }
      if (latest.data === null) {
        useSessionStore.getState().markAutoResumeDone(projectRoot);
        return;
      }
      const session = latest.data;
      if (!stale) {
        await replaySession(projectRoot, session);
      }
    })();
    return () => {
      stale = true;
    };
  }, [projectRoot, autoResumeDoneRoot]);

  // 计划生成轮结束：toast「已生成计划 vN」+ 一键跳计划页。以 endedTurnSeq 单调递增触发，
  // 仅处理一次（seq 去重）。planVersion 缺席 = 普通讨论轮，不打扰。
  const handledPlanSeq = useRef(0);
  useEffect(() => {
    if (endedTurnSeq === handledPlanSeq.current) {
      return;
    }
    handledPlanSeq.current = endedTurnSeq;
    const version = lastEndedTurn?.planVersion;
    if (version !== undefined) {
      toast.success(t("session.planGenerated", { version }), {
        action: { label: t("session.viewPlan"), onClick: () => void navigate("/plan") },
      });
    }
  }, [endedTurnSeq, lastEndedTurn, navigate, t]);

  // 消息合流（T8.2b-b → T8.3b 多轮）：历史消息（回放 + 固化）在前，当前会话的在飞轮
  // 按开始序追加在后（时间序交错：各轮的用户输入在发起时已按序进历史）。
  // 去重以 turnId：历史里已有本轮 assistant 条目（固化先于本渲染帧）就不再从流式缓存
  // 派生第二份；流式条目 id 与固化后的历史条目同构（`${turnId}:assistant`），切换不重挂。
  const sessionTurns = currentSessionTurns(activeTurns, activeSessionId);
  const history: readonly ChatMessageView[] = historyMessages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    ...(m.interrupted === true ? { interrupted: true } : {}),
  }));
  const streamingMessages: readonly ChatMessageView[] = sessionTurns
    .filter(
      (turn) => !historyMessages.some((m) => m.turnId === turn.turnId && m.role === "assistant"),
    )
    .map((turn) => ({
      id: `${turn.turnId}:assistant`,
      role: "assistant" as const,
      text: turn.text,
      streaming: true,
    }));
  const messages: readonly ChatMessageView[] = [...history, ...streamingMessages];

  // busy = 当前会话有在飞轮（T8.3b 语义）：别的会话的并发轮不禁用本会话输入
  const busy = sessionTurns.length > 0;
  const statusView = sessionStatusView(activeTurns, activeSessionId, lastEndedView);

  // 发起被拒 / IPC 失败时 toast 提示（T8.3b）：被拒轮从在飞表移除、不留"已结束"占位，
  // 拒绝原因（含并行互斥）须有一条可见反馈——此前的 turnError 单值随多轮改造移除，改 toast。
  const toastIfRejected = (settled: Awaited<ReturnType<typeof startSessionTurn>>): void => {
    const description =
      settled.ack !== null && !settled.ack.accepted ? settled.ack.reason : settled.errorMessage;
    if (description !== undefined) {
      toast.error(t("session.startRejected"), { description });
    }
  };

  const onSend = (text: string, directExecute: boolean): void => {
    if (entry === null || activeProfile === null) {
      return;
    }
    void startSessionTurn({
      projectRoot: entry.rootPath,
      profileId: activeProfile.id,
      // directExecute（T5.3）：本轮「直接做」跳过习惯整形；缺省不带该字段
      input: { kind: "planner-message", text, ...(directExecute ? { directExecute: true } : {}) },
      // 有当前会话 = 续接（原生恢复 / 上下文重建）；无 = 开新会话（T4.3）
      ...(activeSessionId !== null ? { sessionId: activeSessionId } : {}),
      // 自定义角色 Profile（T8.4）：本地预置轮回显其角色（权威值仍是 started.role）
      ...(localRole !== undefined ? { localRole } : {}),
    }).then(toastIfRejected);
  };

  // 生成计划（T4.6，§12「出计划」）：据当前讨论发起一轮 planner-plan（续接当前会话以复用上下文）。
  const onGeneratePlan = (): void => {
    if (entry === null || activeProfile === null) {
      return;
    }
    // 计划生成轮恒按 planner 执行（编排器 T8.4 口径：结构化输出合同只属于 planner），
    // 故不传 localRole——即便当前选的是自定义角色 Profile。
    void startSessionTurn({
      projectRoot: entry.rootPath,
      profileId: activeProfile.id,
      input: { kind: "planner-plan" },
      ...(activeSessionId !== null ? { sessionId: activeSessionId } : {}),
    }).then(toastIfRejected);
  };

  // 从恢复列表选中一条历史会话作为续接目标：回放那份对话（T8.2b-b：选中即看到内容），
  // 下一次发言即以该会话续接。回放本读不出来时退回"只设目标"——续接能力不依赖回放。
  const onResume = (session: SessionRecord): void => {
    if (entry === null) {
      return;
    }
    void replaySession(entry.rootPath, session).then((ok) => {
      if (!ok) {
        setActiveSessionId(session.id);
      }
      toast.info(t("session.resume.readyToast"));
    });
  };

  // 取消当前会话的全部在飞轮（并发时通常只有一条——Composer 在飞即禁发，
  // 多条只会来自任务页对同一会话的续接派发；一键全取消与"取消"字面一致）。
  const onCancel = (): void => {
    if (sessionTurns.length === 0) {
      return;
    }
    setCancelling(true);
    void Promise.all(sessionTurns.map((turn) => cancelSessionTurn(turn.turnId))).finally(() =>
      setCancelling(false),
    );
  };

  const composerDisabledReason =
    activeProfile === null && !profileLoading
      ? t("session.noPlannerProfile")
      : busy
        ? t("session.turnInProgress")
        : undefined;

  return (
    <>
      <PageHeader title={t("nav.session.label")} description={t("nav.session.question")} />
      {loading ? (
        <LoadingState variant="list" />
      ) : entry === null ? (
        <NoActiveProject />
      ) : (
        <>
          <SessionStatusBar
            projectName={entry.name}
            role={statusView.role}
            model={statusView.model}
            status={statusView.status}
            resumeKind={statusView.resumeKind}
            actions={
              <div className="flex items-center gap-2">
                {/* 讨论 Profile 选择（T8.4）：仅当有多个可选（planner + 自定义角色）时呈现；
                    在飞时禁用——正在进行的轮不换承载者 */}
                {discussionProfiles.length > 1 ? (
                  <select
                    className="h-6 cursor-pointer rounded border border-border bg-surface px-1 text-xs text-fg"
                    aria-label={t("session.discussionProfile")}
                    value={activeProfile?.id ?? ""}
                    disabled={busy}
                    onChange={(e) => setSelectedProfileId(e.target.value)}
                  >
                    {discussionProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setHandoffOpen(true)}
                >
                  <ArrowLeftRight aria-hidden size={14} />
                  {t("session.handoff.action")}
                </Button>
              </div>
            }
          />
          {handoffOpen ? (
            <HandoffDialog
              open
              onOpenChange={setHandoffOpen}
              projectRoot={entry.rootPath}
              currentProfile={activeProfile}
            />
          ) : null}
          {!busy ? (
            <SessionResumePanel
              projectRoot={entry.rootPath}
              activeSessionId={activeSessionId}
              onResume={onResume}
              disabled={activeProfile === null}
            />
          ) : null}
          <SessionReplayBanner />
          <MessageStream messages={messages} emptyMessage={t("session.empty")} />
          {/* 坏行如实标注（§1.4 红线 3）：读得出来的都在上面，读不出来的不假装不存在 */}
          {replay !== null && replay.sessionId === activeSessionId && replay.skippedLines > 0 ? (
            <p className="shrink-0 px-4 py-1 text-center text-[11px] text-fg-subtle">
              {t("session.replay.skippedLines", { count: replay.skippedLines })}
            </p>
          ) : null}
          <PermissionBanner />
          {busy ? (
            <div className="shrink-0 border-t border-border px-3 py-2">
              <div className="mx-auto flex max-w-3xl justify-end">
                <Button variant="ghost" size="sm" disabled={cancelling} onClick={onCancel}>
                  {t("session.cancelTurn")}
                </Button>
              </div>
            </div>
          ) : null}
          <Composer
            onSend={onSend}
            onGeneratePlan={onGeneratePlan}
            disabled={busy || activeProfile === null}
            {...(composerDisabledReason !== undefined
              ? { disabledReason: composerDisabledReason }
              : {})}
          />
        </>
      )}
    </>
  );
}
