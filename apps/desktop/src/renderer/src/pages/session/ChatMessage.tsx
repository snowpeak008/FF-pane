import type { LocalSessionId } from "@ff-pane/shared";
import { BookMarked, Check, Copy } from "lucide-react";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { useSessionStore } from "../../stores/session";
import { captureTitleOf, KnowledgeNoteDialog } from "../knowledge";
import { type ChatSegment, parseChatSegments } from "./chat-segments";

/** 消息角色（会话页只区分用户与 Agent 两侧）。 */
export type ChatRole = "user" | "assistant";

/** 消息流的单条视图模型（内容 = 已累积文本；streaming = 本轮仍在输出）。 */
export interface ChatMessageView {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly streaming?: boolean;
  /** 该轮被中断（T8.2b-b 回放标注：应用退出时没说完），正文下方显式提示。 */
  readonly interrupted?: boolean;
}

const COPIED_MS = 2_000;

function CodeBlock({ lang, text }: { readonly lang: string; readonly text: string }): ReactElement {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_MS);
    });
  };
  return (
    <div className="overflow-hidden rounded-sm border border-border bg-surface-sunken">
      <div className="flex h-6 items-center justify-between border-b border-border px-2">
        <span className="font-mono text-2xs text-fg-subtle">{lang || t("session.code.plain")}</span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={copied ? t("common.copied") : t("common.copy")}
          title={copied ? t("common.copied") : t("common.copy")}
          onClick={copy}
        >
          {copied ? (
            <Check aria-hidden className="text-success-text" size={14} />
          ) : (
            <Copy aria-hidden size={14} />
          )}
        </Button>
      </div>
      <pre className="max-h-96 overflow-auto p-2 font-mono text-xs whitespace-pre text-fg select-text">
        {text}
      </pre>
    </div>
  );
}

function Segment({ segment }: { readonly segment: ChatSegment }): ReactElement {
  if (segment.kind === "code") {
    return <CodeBlock lang={segment.lang} text={segment.text} />;
  }
  return <p className="text-base whitespace-pre-wrap text-fg select-text">{segment.text}</p>;
}

export interface ChatMessageProps {
  readonly message: ChatMessageView;
}

/**
 * 单条消息（W3.4a / 设计系统 §1.1 长文本 text-base）。
 * 内容按 §代码块/散文分段渲染；流式进行中在末尾显示脉冲光标（数据行为，非装饰）。
 */
export function ChatMessage({ message }: ChatMessageProps): ReactElement {
  const { t } = useTranslation();
  const [capturing, setCapturing] = useState(false);
  const sessionId = useSessionStore((state) => state.activeSessionId);
  const segments = parseChatSegments(message.text);
  const copyMessage = (): void => {
    void navigator.clipboard.writeText(message.text).then(() => {
      toast.success(t("common.copied"));
    });
  };
  return (
    <div className="group flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-xs font-medium",
            message.role === "user" ? "text-fg-muted" : "text-primary-text",
          )}
        >
          {t(`session.role.${message.role}`)}
        </span>
        <div className="flex items-center gap-0.5">
          {/* 「存入知识库」（§8.3.2 导入方式二 / §11.2 消息级操作）：
              流式进行中不给按钮——此刻的正文只是半截，收录进去的是一份注定不完整的资料 */}
          {message.streaming === true ? null : (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={t("knowledge.capture")}
              title={t("knowledge.capture")}
              onClick={() => setCapturing(true)}
            >
              <BookMarked aria-hidden size={14} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t("common.copy")}
            title={t("common.copy")}
            onClick={copyMessage}
          >
            <Copy aria-hidden size={14} />
          </Button>
        </div>
      </div>

      <KnowledgeNoteDialog
        open={capturing}
        onOpenChange={setCapturing}
        seedTitle={captureTitleOf(message.text)}
        seedContent={message.text}
        // 会话还没开起来（本地 ID 尚未登记）时记成手动新建：
        // 与其塞一个指不到任何会话的 ID，不如如实说这条不是从会话来的
        source={
          sessionId === null
            ? { kind: "manual" }
            : { kind: "session_capture", sessionId: sessionId satisfies LocalSessionId }
        }
      />
      <div className="flex flex-col gap-2">
        {segments.map((segment, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 段由内容派生、无稳定 id，随文本整体重渲染
          <Segment key={index} segment={segment} />
        ))}
        {message.streaming === true ? (
          <span
            aria-hidden
            className="inline-block h-4 w-1.5 animate-pulse bg-fg-muted align-text-bottom"
          />
        ) : null}
        {/* 中断标注（T8.2b-b）：中性色而非危险色——不是 Agent 出错，是应用退出打断了它 */}
        {message.interrupted === true ? (
          <p className="rounded bg-surface-sunken px-2 py-1 text-xs text-fg-muted">
            {t("session.replay.interrupted")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
