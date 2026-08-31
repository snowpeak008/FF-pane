import type { KnowledgeQueryRecord, ReviewVerdict, Run, RunEndReason } from "@ff-pane/shared";
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

/**
 * 一次只读知识库检索工具调用（T6.6，§8.3.5 路径二）。
 * 展开的是「调用了什么 + 命中了什么」：查询串、走了哪几路、每条命中的出处与片段。
 */
function KnowledgeQueryCard({
  record,
  locale,
}: {
  readonly record: KnowledgeQueryRecord;
  readonly locale: string;
}): ReactElement {
  const { t } = useTranslation();
  // 如实标注检索路径：纯关键词是一等状态而非缺陷（§8.3.3），
  // 用户看到"只走了关键词"时不该以为出了故障。
  const mode = record.usedVector
    ? t("runs.knowledge.modeHybrid")
    : record.usedFts
      ? t("runs.knowledge.modeKeyword")
      : t("runs.knowledge.modeFallback");

  return (
    <div className="flex flex-col gap-1.5 rounded-sm bg-surface-sunken p-2">
      <div className="flex items-baseline justify-between gap-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg select-text">
          {record.query}
        </code>
        <span className="shrink-0 font-mono text-2xs text-fg-subtle">
          {formatAbsoluteTime(record.calledAt, locale)}
        </span>
      </div>
      <div className="flex items-center gap-2 text-2xs text-fg-subtle">
        <span>{mode}</span>
        <span>·</span>
        <span>{t("runs.knowledge.hitCount", { n: record.hits.length })}</span>
        <span>·</span>
        <span>{t("runs.knowledge.duration", { ms: record.durationMs })}</span>
      </div>
      {record.error !== undefined ? (
        <span className="text-2xs text-danger-text select-text">
          {t("runs.knowledge.failed", { reason: record.error })}
        </span>
      ) : null}
      {record.hits.map((hit) => (
        <div key={hit.chunkId} className="flex flex-col gap-0.5 border-l-2 border-border pl-2">
          <span className="truncate text-2xs text-fg-muted select-text">
            {hit.title}
            {" — "}
            {[
              hit.filePath,
              ...(hit.headingPath !== undefined && hit.headingPath.length > 0
                ? [hit.headingPath.join(" › ")]
                : []),
              ...(hit.page !== undefined ? [`p.${hit.page}`] : []),
            ].join(" — ")}
          </span>
          <span className="text-2xs text-fg-subtle select-text">{hit.snippet}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 执行记录页的「知识库检索」区（T6.6）。
 *
 * 三态而非两态，因为缺省与空数组含义不同（见 Run.knowledgeQueries）：
 * 缺省 = 本轮没开这个工具（整区不显示，不给用户看一个与他无关的空区）；
 * 空数组 = 开了但 Agent 一次没调用（显示并说明，这是有信息量的观察）。
 */
function KnowledgeQueries({
  run,
  locale,
}: {
  readonly run: Run;
  readonly locale: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const queries = run.knowledgeQueries;
  if (queries === undefined) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-fg-muted">{t("runs.knowledge.title")}</h3>
      {queries.length === 0 ? (
        <span className="text-xs text-fg-subtle">{t("runs.knowledge.enabledUnused")}</span>
      ) : (
        // 审计记录没有 ID，而同一轮内同一查询可被重复调用（calledAt + query 都不保证唯一）。
        // 这份列表属于一条已结束的 Run：只读、永不重排也永不插入，正是下标可安全做键的情形。
        queries.map((record, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 已结束 Run 的只读列表，永不重排或插入（理由见上）
          <KnowledgeQueryCard key={`${record.calledAt}-${index}`} record={record} locale={locale} />
        ))
      )}
    </section>
  );
}

/** 结论 → 徽章配色（与任务卡片同源；inconclusive 中性，它不是坏消息）。 */
const VERDICT_CLASS: Readonly<Record<ReviewVerdict, string>> = {
  pass: "bg-success-surface text-success-text",
  fail: "bg-danger-surface text-danger-text",
  inconclusive: "bg-surface-sunken text-fg-muted",
};

/**
 * 审查结论区（T7.2，§3.1）。未审查过时整区不显示——大多数 Run 没有审查，
 * 给每条都挂一个"（未审查）"只会稀释这一页真正要说的事。
 *
 * 明写"不构成验收"：§6.3 的 done ≠ accepted 在界面上必须看得见，否则一个绿色的
 * "通过"徽章会被当成任务已经完事了。
 */
function ReviewSection({
  run,
  locale,
}: {
  readonly run: Run;
  readonly locale: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const review = run.review;
  if (review === undefined) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-fg-muted">{t("runs.review.title")}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={cn("shrink-0 border-transparent", VERDICT_CLASS[review.verdict])}>
          {t(`runs.review.verdict.${review.verdict}`)}
        </Badge>
        <span className="font-mono text-2xs text-fg-subtle">
          {formatAbsoluteTime(review.reviewedAt, locale)}
        </span>
        <span className="text-2xs text-fg-subtle">
          {t("runs.review.by", { profile: review.profileId })}
        </span>
      </div>
      <p className="text-xs whitespace-pre-wrap text-fg select-text">{review.summary}</p>
      {review.findings.length > 0 ? (
        <ul className="flex list-disc flex-col gap-0.5 pl-4">
          {review.findings.map((finding) => (
            <li key={finding} className="text-xs text-fg-muted select-text">
              {finding}
            </li>
          ))}
        </ul>
      ) : null}
      {review.commands.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-2xs text-fg-subtle">{t("runs.review.commands")}</span>
          {review.commands.map((cmd) => (
            <code
              key={`${cmd.command}-${cmd.exitCode}`}
              className="truncate font-mono text-2xs text-fg-muted select-text"
            >
              {cmd.command} → {cmd.exitCode}
            </code>
          ))}
        </div>
      ) : (
        // 一份没跑过任何命令的结论与跑过的不是一个分量，如实说明（见 ReviewRecord.commands）
        <span className="text-2xs text-fg-subtle">{t("runs.review.noCommands")}</span>
      )}
      <span className="text-2xs text-fg-subtle">{t("runs.review.notAcceptance")}</span>
    </section>
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

      <ReviewSection run={run} locale={locale} />

      <KnowledgeQueries run={run} locale={locale} />

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
            <div className="flex flex-wrap items-center gap-2">
              <EndReasonBadge run={run} />
              <span className="text-xs text-fg-subtle">
                {t("runs.attempt", { n: run.attempt })}
              </span>
              {/* 结论进列表，否则用户得逐条点开才知道哪次审过 */}
              {run.review !== undefined ? (
                <Badge
                  className={cn("shrink-0 border-transparent", VERDICT_CLASS[run.review.verdict])}
                >
                  {t(`runs.review.verdict.${run.review.verdict}`)}
                </Badge>
              ) : null}
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
