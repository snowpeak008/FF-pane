/**
 * 设置 → 工作台 →「Claude 沙盒」（T11.20，计划 docs/全放开与执行窗口权限计划.md §3.4）。
 * 「可改+跑命令」的 Claude 窗口在这个沙盒里跑命令：这里看 Claude 版本够不够、沙盒装没装，装、卸。
 * 装、卸都跑用户自己那份 Claude 的 `claude sandbox install / uninstall`，会弹一次管理员确认。
 */

import { RefreshCw } from "lucide-react";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ClaudeSandboxCommandResult,
  ClaudeSandboxStatusView,
} from "../../../../shared-ipc/contracts";
import { InlineLoading } from "../../components/states/LoadingState";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Tooltip } from "../../components/ui/Tooltip";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { cn } from "../../lib/cn";

type Action = "install" | "uninstall";

export function ClaudeSandboxSection(): ReactElement {
  const { t } = useTranslation();
  const statusQuery = useInvokeQuery("claude-sandbox:status");
  const status = queryData(statusQuery.state);
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [output, setOutput] = useState<ClaudeSandboxCommandResult | null>(null);

  const run = async (action: Action): Promise<void> => {
    setPending(null);
    setBusy(action);
    setOutput(null);
    const settled = await invokeQuery(
      action === "install" ? "claude-sandbox:install" : "claude-sandbox:uninstall",
    );
    setBusy(null);
    setOutput(
      settled.status === "error" ? { ok: false, message: settled.error.message } : settled.data,
    );
    statusQuery.refetch();
  };

  return (
    <section className="flex flex-col gap-2" data-testid="settings-claude-sandbox">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-fg">{t("claudeSandbox.title")}</h2>
        <Tooltip content={t("claudeSandbox.refresh")}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("claudeSandbox.refresh")}
            data-testid="claude-sandbox-refresh"
            onClick={() => statusQuery.refetch()}
          >
            <RefreshCw aria-hidden size={14} />
          </Button>
        </Tooltip>
      </div>
      <p className="text-xs text-fg-subtle">{t("claudeSandbox.intro")}</p>

      {statusQuery.state.status === "error" ? (
        <span className="text-xs text-danger-text">{statusQuery.state.error.message}</span>
      ) : status === undefined ? (
        <InlineLoading />
      ) : (
        <StatusCard
          status={status}
          busy={busy}
          onInstall={() => setPending("install")}
          onUninstall={() => setPending("uninstall")}
        />
      )}

      {output !== null ? (
        <pre
          className={cn(
            "max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border px-3 py-2 font-mono text-2xs",
            output.ok
              ? "border-border bg-surface-sunken text-fg-muted"
              : "border-danger-border bg-danger-surface text-danger-text",
          )}
          data-testid="claude-sandbox-output"
        >
          {output.message ||
            (output.ok ? t("claudeSandbox.command.ok") : t("claudeSandbox.command.failed"))}
        </pre>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
          }
        }}
        title={
          pending === "uninstall"
            ? t("claudeSandbox.uninstall.confirmTitle")
            : t("claudeSandbox.install.confirmTitle")
        }
        description={
          pending === "uninstall"
            ? t("claudeSandbox.uninstall.confirmBody")
            : t("claudeSandbox.install.confirmBody")
        }
        tone={pending === "uninstall" ? "danger" : "primary"}
        confirmLabel={
          pending === "uninstall"
            ? t("claudeSandbox.uninstall.action")
            : t("claudeSandbox.install.action")
        }
        onConfirm={() => {
          if (pending !== null) {
            void run(pending);
          }
        }}
      />
    </section>
  );
}

function StatusCard({
  status,
  busy,
  onInstall,
  onUninstall,
}: {
  readonly status: ClaudeSandboxStatusView;
  readonly busy: Action | null;
  readonly onInstall: () => void;
  readonly onUninstall: () => void;
}): ReactElement {
  const { t } = useTranslation();
  if (!status.platformSupported) {
    return <span className="text-xs text-fg-muted">{t("claudeSandbox.notWindows")}</span>;
  }
  if (!status.claudeFound) {
    return (
      <span className="text-xs text-danger-text" data-testid="claude-sandbox-state">
        {t("claudeSandbox.claudeMissing")}
      </span>
    );
  }
  const ready = status.versionOk && status.installed;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
      <div className="flex flex-col gap-0.5 text-xs" data-testid="claude-sandbox-state">
        <span className={ready ? "text-success-text" : "text-warning-text"}>
          {ready ? t("claudeSandbox.state.ready") : t("claudeSandbox.state.notReady")}
        </span>
        <span className="text-fg-muted" data-testid="claude-sandbox-version">
          {status.versionOk
            ? t("claudeSandbox.version.ok", {
                version: status.claudeVersion ?? "?",
                min: status.minVersion,
              })
            : t("claudeSandbox.version.old", {
                version: status.claudeVersion ?? "?",
                min: status.minVersion,
              })}
        </span>
        <span className="text-fg-muted" data-testid="claude-sandbox-installed">
          {status.installed ? t("claudeSandbox.installed.yes") : t("claudeSandbox.installed.no")}
        </span>
        {status.reasons.map((reason) => (
          <span key={reason} className="text-fg-subtle">
            {reason}
          </span>
        ))}
      </div>
      {!status.versionOk ? (
        <code className="w-fit rounded-sm bg-surface-sunken px-2 py-1 font-mono text-2xs text-fg">
          npm i -g @anthropic-ai/claude-code@latest
        </code>
      ) : null}
      <div className="flex gap-2">
        {status.installed ? (
          <Button
            size="sm"
            variant="secondary"
            data-testid="claude-sandbox-uninstall"
            loading={busy === "uninstall"}
            disabled={busy !== null || !status.versionOk}
            onClick={onUninstall}
          >
            {t("claudeSandbox.uninstall.action")}
          </Button>
        ) : (
          <Button
            size="sm"
            data-testid="claude-sandbox-install"
            loading={busy === "install"}
            disabled={busy !== null || !status.versionOk}
            onClick={onInstall}
          >
            {t("claudeSandbox.install.action")}
          </Button>
        )}
      </div>
    </div>
  );
}
