import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../../layout/PageHeader";
import type { ChatMessageView } from "./ChatMessage";
import { MessageStream } from "./MessageStream";

/**
 * 会话页（W3.4 / 项目设计计划 §11.2「我正在和谁讨论什么」）。
 *
 * 本工单（W3.4a）落消息流渲染骨架；真实对话（状态条数据、流式输出、发送）在
 * Phase 4 十步流程接线时打通——工作台不持久化消息历史（§10.2 规则 3），
 * 消息由 Agent 运行时的流式事件喂入。此处暂无进行中会话，显示空态。
 */
export function SessionPage(): ReactElement {
  const { t } = useTranslation();
  // Phase 4 接线前无实时消息源；消息流组件已就位，等 Agent 流式事件喂入。
  const messages: readonly ChatMessageView[] = [];

  return (
    <>
      <PageHeader title={t("nav.session.label")} description={t("nav.session.question")} />
      <MessageStream messages={messages} emptyMessage={t("session.empty")} />
    </>
  );
}
