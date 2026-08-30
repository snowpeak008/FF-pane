import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { formatErrorDetail, summarizeError } from "./error-text";

/** 复制成功提示的停留时长（ms）。 */
const COPIED_FEEDBACK_MS = 2_000;

export interface ErrorStateAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ErrorStateProps {
  /** 一句人类可读的概括（已翻译），如"读取项目列表失败"。缺省取错误 message。 */
  readonly summary?: string;
  /** 抛出物原样传入，由本组件负责提取原文；禁止调用方先吞成 "出错了"。 */
  readonly error: unknown;
  /** 重试（primary）。没有可重试动作时才省略。 */
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  /** 次要动作，如能定位到设置项时的"去设置"（§6.2）。 */
  readonly action?: ErrorStateAction;
  /** 复制回调：拿到的是实际写入剪贴板的错误原文，便于页面上报或弹 toast。 */
  readonly onCopy?: (detail: string) => void;
  /** 默认展开错误原文（如整页错误）；区块内错误默认折叠。 */
  readonly defaultExpanded?: boolean;
  readonly className?: string;
}

/**
 * 错误态（设计系统 §6.2 / 开发计划 §1.5 第 2 条）。
 *
 * 三件套缺一不可：错误原文（font-mono、可展开、可复制）+ 一句概括 + 重试按钮。
 * 禁止用 toast 替代区块内错误态——toast 会消失，错误必须留在原地可查。
 */
export function ErrorState({
  summary,
  error,
  onRetry,
  retryLabel,
  action,
  onCopy,
  defaultExpanded = false,
  className,
}: ErrorStateProps): ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== undefined) {
        window.clearTimeout(copyTimer.current);
      }
    };
  }, []);

  const detail = formatErrorDetail(error);
  const headline = summary ?? summarizeError(error);

  const handleCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(detail)
      .then(() => {
        setCopied(true);
        if (copyTimer.current !== undefined) {
          window.clearTimeout(copyTimer.current);
        }
        copyTimer.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
        onCopy?.(detail);
      })
      .catch((thrown: unknown) => {
        // 开发者日志英文；复制失败不阻断错误态本身的可读性（原文已在页面上可选中）
        console.error("[renderer] copying error detail to clipboard failed:", thrown);
      });
  }, [detail, onCopy]);

  return (
    <div
      className={cn(
        "flex h-full min-h-32 flex-col items-center justify-center gap-3 p-6",
        className,
      )}
      role="alert"
    >
      <div className="flex w-full max-w-2xl flex-col gap-2">
        <div className="flex items-start gap-2">
          <AlertTriangle aria-hidden className="mt-0.5 shrink-0 text-danger-text" size={16} />
          <p className="text-sm text-fg">{headline}</p>
        </div>

        {detail.length > 0 ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
              >
                {expanded ? (
                  <ChevronDown aria-hidden size={14} />
                ) : (
                  <ChevronRight aria-hidden size={14} />
                )}
                {expanded ? t("common.errorDetail.hide") : t("common.errorDetail.show")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                onClick={handleCopy}
                aria-label={copied ? t("common.copied") : t("common.copy")}
                title={copied ? t("common.copied") : t("common.copy")}
              >
                {copied ? (
                  <Check aria-hidden className="text-success-text" size={14} />
                ) : (
                  <Copy aria-hidden size={14} />
                )}
              </Button>
            </div>
            {expanded ? (
              <pre className="max-h-64 overflow-auto rounded-sm border border-border bg-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap text-fg select-text">
                {detail}
              </pre>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          {onRetry !== undefined ? (
            <Button variant="primary" size="md" onClick={onRetry}>
              {retryLabel ?? t("common.retry")}
            </Button>
          ) : null}
          {action !== undefined ? (
            <Button variant="secondary" size="md" onClick={action.onClick}>
              {action.label}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
