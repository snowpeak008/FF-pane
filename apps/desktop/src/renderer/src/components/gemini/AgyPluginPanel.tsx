/**
 * agy 的 ffpane 工具插件（计划 docs/用户内容可插拔与agy工具插件计划.md §2.4）。
 *
 * - AgyPluginPanel：设置 → Provider →「本机已登录」→ agy 里的添加 / 更新 / 卸载。
 * - AgyPluginNotice：新建 Gemini 窗口时的一行说明（没添加就明说没有 ffpane 工具）。不弹窗、不抢焦点。
 *
 * 添加由用户点按钮，软件不会自己装；已添加的才会在启动时自动更新；没添加的不会被补装。
 */

import { type ReactElement, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgyPluginActionResult, AgyPluginView } from "../../../../shared-ipc/contracts";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { cn } from "../../lib/cn";
import { InlineLoading } from "../states/LoadingState";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";

type Busy = "install" | "uninstall" | null;

function stateTone(view: AgyPluginView): "success" | "warning" | "neutral" | "danger" {
  switch (view.state) {
    case "installed":
      return view.current && view.enabled ? "success" : "warning";
    case "not-installed":
      return "neutral";
    case "foreign":
      return "warning";
    default:
      return "danger";
  }
}

function stateText(t: (key: string) => string, view: AgyPluginView): string {
  switch (view.state) {
    case "agy-missing":
      return t("agyPlugin.state.missing");
    case "not-installed":
      return t("agyPlugin.state.notInstalled");
    case "foreign":
      return t("agyPlugin.state.foreign");
    case "installed":
      if (!view.enabled) {
        return t("agyPlugin.state.disabled");
      }
      return view.current ? t("agyPlugin.state.current") : t("agyPlugin.state.stale");
  }
}

export function AgyPluginPanel(): ReactElement {
  const { t } = useTranslation();
  const query = useInvokeQuery("agy-plugin:status");
  const view = queryData(query.state);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [result, setResult] = useState<AgyPluginActionResult | undefined>(undefined);

  const run = useCallback(
    async (kind: "install" | "uninstall") => {
      setBusy(kind);
      setResult(undefined);
      const settled = await invokeQuery(
        kind === "install" ? "agy-plugin:install" : "agy-plugin:uninstall",
      );
      setBusy(null);
      if (settled.status === "error") {
        setResult({
          ok: false,
          error: settled.error.message,
          status: view ?? { state: "not-installed" },
        });
      } else {
        setResult(settled.data);
      }
      query.refetch();
    },
    [query, view],
  );

  if (query.state.status === "error") {
    return (
      <p className="text-xs text-danger-text" data-testid="agy-plugin-error">
        {query.state.error.message}
      </p>
    );
  }
  if (view === undefined) {
    return <InlineLoading />;
  }

  const installed = view.state === "installed";
  const stale = view.state === "installed" && !view.current;
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
      data-testid="agy-plugin-panel"
      data-state={view.state === "installed" ? (view.current ? "current" : "stale") : view.state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">{t("agyPlugin.title")}</span>
        <Badge tone={stateTone(view)} data-testid="agy-plugin-state">
          {stateText(t, view)}
        </Badge>
      </div>
      <p className="text-xs text-fg-muted">{t("agyPlugin.intro")}</p>
      {installed ? <p className="text-xs text-fg-subtle">{t("agyPlugin.autoUpdate")}</p> : null}
      {view.state === "installed" && view.lastError !== undefined ? (
        <p className="text-xs text-warning-text" data-testid="agy-plugin-last-error">
          {t("agyPlugin.lastError", { error: view.lastError })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {view.state === "not-installed" ? (
          <Button
            size="sm"
            loading={busy === "install"}
            disabled={busy !== null}
            data-testid="agy-plugin-add"
            onClick={() => setConfirmAdd(true)}
          >
            {t("agyPlugin.add")}
          </Button>
        ) : null}
        {stale ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy === "install"}
            disabled={busy !== null}
            data-testid="agy-plugin-update"
            onClick={() => void run("install")}
          >
            {t("agyPlugin.update")}
          </Button>
        ) : null}
        {installed ? (
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "uninstall"}
            disabled={busy !== null}
            data-testid="agy-plugin-remove"
            onClick={() => setConfirmRemove(true)}
          >
            {t("agyPlugin.remove")}
          </Button>
        ) : null}
      </div>
      {result !== undefined ? (
        <p
          className={cn("text-xs", result.ok ? "text-fg-muted" : "text-danger-text")}
          data-testid="agy-plugin-result"
        >
          {result.ok ? t("agyPlugin.done") : (result.error ?? t("agyPlugin.failed"))}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmAdd}
        onOpenChange={setConfirmAdd}
        title={t("agyPlugin.confirmAddTitle")}
        description={t("agyPlugin.confirmAddBody")}
        tone="primary"
        confirmLabel={t("agyPlugin.add")}
        onConfirm={() => {
          setConfirmAdd(false);
          void run("install");
        }}
      />
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("agyPlugin.confirmRemoveTitle")}
        description={t("agyPlugin.confirmRemoveBody")}
        tone="primary"
        confirmLabel={t("agyPlugin.remove")}
        onConfirm={() => {
          setConfirmRemove(false);
          void run("uninstall");
        }}
      />
    </div>
  );
}

/** 新建 Gemini 窗口时的一行说明：没添加插件就明说这个窗口没有 ffpane 工具。已添加或没装 agy 时什么都不显示。 */
export function AgyPluginNotice(): ReactElement | null {
  const { t } = useTranslation();
  const view = queryData(useInvokeQuery("agy-plugin:status").state);
  if (view === undefined || view.state === "installed" || view.state === "agy-missing") {
    return null;
  }
  return (
    <p className="text-xs text-warning-text" data-testid="workbench-gemini-plugin-notice">
      {view.state === "foreign" ? t("agyPlugin.noticeForeign") : t("agyPlugin.notice")}
    </p>
  );
}
