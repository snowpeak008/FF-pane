import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { LoadingState } from "../../components/states/LoadingState";
import { useActiveProject } from "../../hooks/useActiveProject";
import { PageHeader } from "../../layout/PageHeader";
import { useSessionStore } from "../../stores/session";
import { NoActiveProject } from "../NoActiveProject";
import type { ChatMessageView } from "./ChatMessage";
import { Composer } from "./Composer";
import { MessageStream } from "./MessageStream";
import { SessionStatusBar } from "./SessionStatusBar";

/**
 * 会话页（W3.4 / §11.2「我正在和谁讨论什么」）：状态条 + 消息流 + 输入区。
 *
 * 以当前项目为作用域。工作台不持久化会话历史（§10.2 规则 3）——消息由 Agent 运行时的
 * 流式事件喂入 session store 的 streamingTurn；真实对话（发送 / 流式 / 状态条完整信息）
 * 在 Phase 4 十步流程接通。此前显示空态 + 可编辑草稿的输入区骨架。
 */
export function SessionPage(): ReactElement {
  const { t } = useTranslation();
  const { entry, loading } = useActiveProject();
  const streamingTurn = useSessionStore((s) => s.streamingTurn);

  // 目前唯一的消息源是流式缓存（Phase 4 喂入）；无在飞轮次时为空。
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

  return (
    <>
      <PageHeader title={t("nav.session.label")} description={t("nav.session.question")} />
      {loading ? (
        <LoadingState variant="list" />
      ) : entry === null ? (
        <NoActiveProject />
      ) : (
        <>
          <SessionStatusBar projectName={entry.name} />
          <MessageStream messages={messages} emptyMessage={t("session.empty")} />
          <Composer />
        </>
      )}
    </>
  );
}
