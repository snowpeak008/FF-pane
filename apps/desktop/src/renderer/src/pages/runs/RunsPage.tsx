import type { Run, RunEndReason } from "@ff-pane/shared";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import { LoadingState } from "../../components/states/LoadingState";
import { Badge } from "../../components/ui/Badge";
import { useActiveProject } from "../../hooks/useActiveProject";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { PageHeader } from "../../layout/PageHeader";
import { cn } from "../../lib/cn";
import { formatAbsoluteTime } from "../../lib/time";
import { NoActiveProject } from "../NoActiveProject";
import { DiffView } from "./DiffView";

/** 结束原因 → 徽章底色/文字类。 */
const END_REASON_CLASS: Readonly<Record<RunEndReason, string>> = {
  completed: "bg-success-surface text-success-text",
  failed: "bg-danger-surface text-danger-text",
  crashed: "bg-danger-surface text-danger-text",
  cancelled: "bg-surface-sunken text-fg-muted",
};

function EndReasonBadge({ run }: { readonly run: Run }): ReactElement {
  const { t } = useTranslation();
  const reason = run.endReason;
  if (reason === undefined) {
    return <Badge className="shrink-0">{t("runs.endReason.running")}</Badge>;
  }
  return (
    <Badge className={cn("shrink-0 border-transparent", END_REASON_CLASS[reason])}>
      {t(`runs.endReason.${reason}`)}
    </Badge>
  );
}

function RunDetail({ run, locale }: { readonly run: Run; readonly locale: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <EndReasonBadge run={run} />
          <span className="font-mono text-xs text-fg-muted">{run.id}</span>
          <span className="text-xs text-fg-subtle">{t("runs.attempt", { n: run.attempt })}</span>
        </div>
        <span className="font-mono text-xs text-fg-subtle">
          {formatAbsoluteTime(run.startedAt, locale)}
        </span>
      </div>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-fg-muted">{t("runs.commands")}</h3>
        {run.commands.length === 0 ? (
          <span className="text-xs text-fg-subtle">{t("runs.none")}</span>
        ) : (
          run.commands.map((cmd) => (
            <div
              key={`${cmd.command}-${cmd.exitCode}`}
              className="flex items-center justify-between gap-3 rounded-sm bg-surface-sunken px-2 py-1"
            >
              <code className="truncate font-mono text-xs text-fg select-text">{cmd.command}</code>
              <span
                className={cn(
                  "shrink-0 font-mono text-xs",
                  cmd.exitCode === 0 ? "text-fg-muted" : "text-danger-text",
                )}
              >
                {t("runs.exitCode", { code: cmd.exitCode })}
              </span>
            </div>
          ))
        )}
      </section>

      {run.verifyResult !== undefined ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-fg-muted">{t("runs.verify")}</h3>
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs text-fg select-text">
              {run.verifyResult.command}
            </code>
            <span
              className={cn(
                "font-mono text-xs",
                run.verifyResult.exitCode === 0 ? "text-success-text" : "text-danger-text",
              )}
            >
              {run.verifyResult.exitCode === 0 ? t("runs.verifyPassed") : t("runs.verifyFailed")}
            </span>
          </div>
          {run.verifyResult.output.length > 0 ? (
            <pre className="max-h-40 overflow-auto rounded-sm bg-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap text-fg select-text">
              {run.verifyResult.output}
            </pre>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-fg-muted">{t("runs.fileChanges")}</h3>
        {run.fileChanges.length === 0 ? (
          <span className="text-xs text-fg-subtle">{t("runs.noChanges")}</span>
        ) : (
          run.fileChanges.map((change) => (
            <div key={change.path} className="flex flex-col gap-1">
              <span className="font-mono text-xs text-fg-muted select-text">{change.path}</span>
              <DiffView diff={change.diff} />
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function RunsView({ projectRoot }: { readonly projectRoot: string }): ReactElement {
  const { t, i18n } = useTranslation();
  const { state, refetch } = useInvokeQuery("runs:list", { projectRoot });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (state.status === "error") {
    return (
      <ErrorState
        summary={t("runs.loadError")}
        error={state.error}
        onRetry={refetch}
        className="min-h-0"
      />
    );
  }
  if (state.status !== "success") {
    return <LoadingState variant="list" />;
  }
  if (state.data.length === 0) {
    return <EmptyState className="min-h-0 flex-1" message={t("runs.empty")} />;
  }

  const selected = state.data.find((r) => r.id === selectedId) ?? state.data[0];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-64 shrink-0 overflow-y-auto border-r border-border">
        {state.data.map((run) => (
          <button
            type="button"
            key={run.id}
            onClick={() => setSelectedId(run.id)}
            className={cn(
              "flex w-full flex-col gap-1 border-b border-border px-3 py-2 text-left",
              run.id === selected?.id ? "bg-surface-active" : "hover:bg-surface-hover",
            )}
          >
            <div className="flex items-center gap-2">
              <EndReasonBadge run={run} />
              <span className="text-xs text-fg-subtle">
                {t("runs.attempt", { n: run.attempt })}
              </span>
            </div>
            <span className="truncate font-mono text-2xs text-fg-muted">{run.id}</span>
          </button>
        ))}
      </div>
      {selected !== undefined ? <RunDetail run={selected} locale={i18n.language} /> : null}
    </div>
  );
}

/**
 * 执行记录页（W3.7 / §11.5「AI 到底改了什么」）：Run 列表 + diff/命令/验证详情。
 * 以当前项目为作用域；Run 由任务派发执行产生（Phase 4），此前显示空态。
 */
export function RunsPage(): ReactElement {
  const { t } = useTranslation();
  const { entry, loading } = useActiveProject();
  return (
    <>
      <PageHeader title={t("nav.runs.label")} description={t("nav.runs.question")} />
      {loading ? (
        <LoadingState variant="list" />
      ) : entry === null ? (
        <NoActiveProject />
      ) : (
        <RunsView projectRoot={entry.rootPath} />
      )}
    </>
  );
}
