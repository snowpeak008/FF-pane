import { type ReactElement, useEffect, useRef } from "react";
import { EmptyState } from "../../components/states/EmptyState";
import { ChatMessage, type ChatMessageView } from "./ChatMessage";

export interface MessageStreamProps {
  readonly messages: readonly ChatMessageView[];
  /** 无消息时的空态一句话（§6.2）。 */
  readonly emptyMessage: string;
}

/**
 * 消息流（W3.4a / 设计系统 §6.1）：增量追加时保持滚动贴底。
 *
 * 长会话虚拟化（§1.1）留待有真实历史数据规模时接入——工作台不持久化消息历史
 * （§10.2 规则 3），单次会话的可见消息量有限，先用原生滚动 + 贴底策略。
 */
export function MessageStream({ messages, emptyMessage }: MessageStreamProps): ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null);
  // 消息数或最后一条内容变化即滚到底（流式追加时跟随）
  const lastText = messages.length > 0 ? messages[messages.length - 1]?.text : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖消息条数与末条文本，追加即贴底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, lastText]);

  if (messages.length === 0) {
    return <EmptyState className="min-h-0 flex-1" message={emptyMessage} />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
