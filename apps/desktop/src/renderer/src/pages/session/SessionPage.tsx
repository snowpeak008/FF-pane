import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { MessageStream } from "./MessageStream";
import { PermissionBanner } from "./PermissionBanner";
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

  const streamingTurn = useSessionStore((s) => s.streamingTurn);
  const turnRole = useSessionStore((s) => s.turnRole);
  const turnModel = useSessionStore((s) => s.turnModel);
  const turnStatus = useSessionStore((s) => s.turnStatus);
  const [cancelling, setCancelling] = useState(false);

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

  const onSend = (text: string): void => {
    if (entry === null || plannerProfile === null) {
      return;
    }
    void startSessionTurn({
      projectRoot: entry.rootPath,
      profileId: plannerProfile.id,
      input: { kind: "planner-message", text },
    });
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
          />
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
