import type { SessionRecord } from "@ff-pane/shared";
import { ArrowLeftRight } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { LoadingState } from "../../components/states/LoadingState";
import { Button } from "../../components/ui/Button";
import { useActiveProject } from "../../hooks/useActiveProject";
import { useRoleProfile } from "../../hooks/useRoleProfile";
import { PageHeader } from "../../layout/PageHeader";
import { cancelSessionTurn, startSessionTurn } from "../../lib/session-run";
import { useSessionStore } from "../../stores/session";
import { NoActiveProject } from "../NoActiveProject";
import type { ChatMessageView } from "./ChatMessage";
import { Composer } from "./Composer";
import { HandoffDialog } from "./HandoffDialog";
import { MessageStream } from "./MessageStream";
import { PermissionBanner } from "./PermissionBanner";
import { SessionResumePanel } from "./SessionResumePanel";
import { SessionStatusBar } from "./SessionStatusBar";

/**
 * 会话页（W3.4 / §11.2「我正在和谁讨论什么」）：状态条 + 消息流 + 权限横幅 + 输入区。
 *
 * 以当前项目为作用域。工作台不持久化会话历史（§10.2 规则 3）——消息由主进程 session:event
 * 流式喂入 session store 的 streamingTurn（全局 SessionEventBridge 唯一订阅）。
 * T4.2 接通：输入区发送 = 发起一轮 Planner 讨论；任务页派发的 Worker 轮亦在此呈现与审批。
 */
export function SessionPage(): ReactElement {
  const { t } = useTranslation();
  const { entry, loading } = useActiveProject();
  const { profile: plannerProfile, loading: profileLoading } = useRoleProfile("planner");

  const navigate = useNavigate();
  const streamingTurn = useSessionStore((s) => s.streamingTurn);
  const turnRole = useSessionStore((s) => s.turnRole);
  const turnModel = useSessionStore((s) => s.turnModel);
  const turnStatus = useSessionStore((s) => s.turnStatus);
  const turnResumeKind = useSessionStore((s) => s.turnResumeKind);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const endedTurnSeq = useSessionStore((s) => s.endedTurnSeq);
  const lastEndedTurn = useSessionStore((s) => s.lastEndedTurn);
  const [cancelling, setCancelling] = useState(false);
  // 跨 Agent 迁移（T7.1，§10.4）：对话框只在打开时挂载——交接包是"此刻的项目现状"快照，
  // 常驻会让它在项目推进后悄悄过期。
  const [handoffOpen, setHandoffOpen] = useState(false);

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

  // 目前唯一的消息源是流式缓存；无在飞轮次时为空。
  const messages: readonly ChatMessageView[] =
    streamingTurn !== null
      ? [
          {
            id: streamingTurn.turnId,
            role: "assistant",
            text: streamingTurn.text,
            streaming: !streamingTurn.done,
          },
        ]
      : [];

  const busy = turnStatus === "running" || turnStatus === "awaiting-permission";

  const onSend = (text: string, directExecute: boolean): void => {
    if (entry === null || plannerProfile === null) {
      return;
    }
    void startSessionTurn({
      projectRoot: entry.rootPath,
      profileId: plannerProfile.id,
      // directExecute（T5.3）：本轮「直接做」跳过习惯整形；缺省不带该字段
      input: { kind: "planner-message", text, ...(directExecute ? { directExecute: true } : {}) },
      // 有当前会话 = 续接（原生恢复 / 上下文重建）；无 = 开新会话（T4.3）
      ...(activeSessionId !== null ? { sessionId: activeSessionId } : {}),
    });
  };

  // 生成计划（T4.6，§12「出计划」）：据当前讨论发起一轮 planner-plan（续接当前会话以复用上下文）。
  const onGeneratePlan = (): void => {
    if (entry === null || plannerProfile === null) {
      return;
    }
    void startSessionTurn({
      projectRoot: entry.rootPath,
      profileId: plannerProfile.id,
      input: { kind: "planner-plan" },
      ...(activeSessionId !== null ? { sessionId: activeSessionId } : {}),
    });
  };

  // 从恢复列表选中一条历史会话作为续接目标：下一次发言即以该会话续接。
  const onResume = (session: SessionRecord): void => {
    setActiveSessionId(session.id);
    toast.info(t("session.resume.readyToast"));
  };

  const onCancel = (): void => {
    if (streamingTurn === null) {
      return;
    }
    setCancelling(true);
    void cancelSessionTurn(streamingTurn.turnId).finally(() => setCancelling(false));
  };

  const composerDisabledReason =
    plannerProfile === null && !profileLoading
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
            role={turnRole}
            model={turnModel}
            status={turnStatus}
            resumeKind={turnResumeKind}
            actions={
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setHandoffOpen(true)}
              >
                <ArrowLeftRight aria-hidden size={14} />
                {t("session.handoff.action")}
              </Button>
            }
          />
          {handoffOpen ? (
            <HandoffDialog
              open
              onOpenChange={setHandoffOpen}
              projectRoot={entry.rootPath}
              currentProfile={plannerProfile}
            />
          ) : null}
          {!busy ? (
            <SessionResumePanel
              projectRoot={entry.rootPath}
              activeSessionId={activeSessionId}
              onResume={onResume}
              disabled={plannerProfile === null}
            />
          ) : null}
          <MessageStream messages={messages} emptyMessage={t("session.empty")} />
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
            disabled={busy || plannerProfile === null}
            {...(composerDisabledReason !== undefined
              ? { disabledReason: composerDisabledReason }
              : {})}
          />
        </>
      )}
    </>
  );
}
