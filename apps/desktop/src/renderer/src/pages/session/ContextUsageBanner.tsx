import { DEFAULT_CONTEXT_WARN_PERCENT } from "@ff-pane/shared";
import { MessageSquarePlus } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { currentSessionTurns, useSessionStore } from "../../stores/session";
import { deriveContextGauge } from "./context-view";

export interface ContextUsageBannerProps {
  /** 当前会话的模型（状态条同源：started 事件权威值优先，无在飞轮时取 Profile 配置）。 */
  readonly model: string | null;
  /** 当前 Profile 的 Runtime（cli_login 缺省模型时按它取保守窗口）。 */
  readonly runtime: string | null;
  /** 一键「开新会话并继承」（接 T9.8 ①：打开 intent=inherit 的 HandoffDialog）。 */
  readonly onInherit: () => void;
}

/**
 * 上下文阈值横幅（T9.8 ②）：当前会话用量达到窗口的 contextWarnPercent（全局设置，
 * 默认 70%）时提示「建议轻装重开」，附一键继承入口。照 SessionReplayBanner 款式
 * （shrink-0 顶部横条），不打断输入——只是消息区上方多一行。
 *
 * 分子优先取真实 usage（store.contextUsage，`context-usage` 事件记账），取不到按
 * 当前视图的转录文本估算并标注「估算」；分母经 deriveContextGauge 的三级回退，
 * 非公开规格命中同样标注估算（context-view.ts 文件头）。
 */
export function ContextUsageBanner({
  model,
  runtime,
  onInherit,
}: ContextUsageBannerProps): ReactElement | null {
  const { t } = useTranslation();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeTurns = useSessionStore((s) => s.activeTurns);
  const historyMessages = useSessionStore((s) => s.historyMessages);
  const contextUsage = useSessionStore((s) => s.contextUsage);
  const { state } = useInvokeQuery("config:get");
  const warnPercent = queryData(state)?.contextWarnPercent ?? DEFAULT_CONTEXT_WARN_PERCENT;

  if (activeSessionId === null) {
    return null;
  }
  // 估算路径的载体：当前视图的历史消息 + 本会话在飞轮已累积的流式文本。
  const transcriptText =
    historyMessages.map((m) => m.text).join("\n") +
    currentSessionTurns(activeTurns, activeSessionId)
      .map((turn) => turn.text)
      .join("\n");
  const gauge = deriveContextGauge({
    usage: contextUsage.get(activeSessionId),
    transcriptText,
    model,
    runtime,
    warnPercent,
  });
  if (gauge === null || !gauge.shouldWarn) {
    return null;
  }

  const usedLabel = gauge.usedTokens.toLocaleString();
  const windowLabel = gauge.windowTokens.toLocaleString();
  return (
    <div
      data-testid="context-usage-banner"
      className="shrink-0 border-b border-border bg-surface-sunken px-4 py-2"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <span className="text-xs text-fg-muted">
          {t("session.contextWarn.banner", {
            percent: gauge.percent,
            used: usedLabel,
            window: windowLabel,
          })}
          {gauge.estimated ? ` ${t("session.contextWarn.estimated")}` : ""}
        </span>
        <div className="ml-auto">
          <Button variant="ghost" size="sm" onClick={onInherit}>
            <MessageSquarePlus aria-hidden size={14} />
            {t("session.inherit.action")}
          </Button>
        </div>
      </div>
    </div>
  );
}
