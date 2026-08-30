import type { Plan, PlanStatus } from "@ff-pane/shared";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import { LoadingState } from "../../components/states/LoadingState";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useActiveProject } from "../../hooks/useActiveProject";
import { invokeQuery } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { PageHeader } from "../../layout/PageHeader";
import { cn } from "../../lib/cn";
import { NoActiveProject } from "../NoActiveProject";

/** 计划状态 → 徽章底色/文字类。 */
const STATUS_CLASS: Readonly<Record<PlanStatus, string>> = {
  draft: "bg-surface-sunken text-fg-muted",
  approved: "bg-success-surface text-success-text",
  superseded: "bg-surface-sunken text-fg-subtle",
  completed: "bg-primary-surface text-primary-text",
  cancelled: "bg-surface-sunken text-fg-subtle",
};

function StatusBadge({ status }: { readonly status: PlanStatus }): ReactElement {
  const { t } = useTranslation();
  return (
    <Badge className={cn("shrink-0 border-transparent", STATUS_CLASS[status])}>
      {t(`plan.status.${status}`)}
    </Badge>
  );
}

/** 条目列表小节：标题 + 项目符号列表；空则显示占位。 */
function ListSection({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly string[];
}): ReactElement {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-fg-muted">{title}</h3>
      {items.length === 0 ? (
        <span className="text-xs text-fg-subtle">{t("plan.none")}</span>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {items.map((item) => (
            <li key={item} className="text-sm text-fg select-text">
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PlanBody({
  plan,
  projectRoot,
  onApproved,
}: {
  readonly plan: Plan;
  readonly projectRoot: string;
  readonly onApproved: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [approving, setApproving] = useState(false);

  const approve = async (): Promise<void> => {
    setApproving(true);
    const settled = await invokeQuery("plans:approve", { projectRoot, version: plan.version });
    setApproving(false);
    if (settled.status === "error") {
      toast.error(t("plan.approveError"), { description: settled.error.message });
      return;
    }
    onApproved();
    toast.success(t("plan.approved", { n: plan.version }));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <StatusBadge status={plan.status} />
        <span className="font-mono text-sm font-medium text-fg">
          {t("plan.version", { n: plan.version })}
        </span>
        {plan.status === "draft" ? (
          <Button
            variant="primary"
            size="md"
            className="ml-auto"
            loading={approving}
            onClick={() => void approve()}
          >
            {t("plan.approve")}
          </Button>
        ) : null}
      </div>

      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium text-fg-muted">{t("plan.section.goal")}</h3>
        <p className="text-base whitespace-pre-wrap text-fg select-text">{plan.goal}</p>
      </section>

      <ListSection title={t("plan.section.scope")} items={plan.scope} />
      <ListSection title={t("plan.section.nonGoals")} items={plan.nonGoals} />
      <ListSection title={t("plan.section.constraints")} items={plan.constraints} />
      <ListSection title={t("plan.section.decisions")} items={plan.decisions} />

      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium text-fg-muted">{t("plan.section.tasks")}</h3>
        {plan.tasks.length === 0 ? (
          <span className="text-xs text-fg-subtle">{t("plan.none")}</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {plan.tasks.map((task) => (
              <li key={task.id} className="text-sm text-fg select-text">
                {task.goal}
                {task.writeScope.length > 0 ? (
                  <span className="ml-2 font-mono text-xs text-fg-muted">
                    {task.writeScope.join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ListSection title={t("plan.section.acceptance")} items={plan.acceptance} />
    </div>
  );
}

function PlanView({ projectRoot }: { readonly projectRoot: string }): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("plans:list", { projectRoot });
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

  if (state.status === "error") {
    return (
      <ErrorState
        summary={t("plan.loadError")}
        error={state.error}
        onRetry={refetch}
        className="min-h-0"
      />
    );
  }
  if (state.status !== "success") {
    return <LoadingState variant="detail" />;
  }
  if (state.data.length === 0) {
    return <EmptyState className="min-h-0 flex-1" message={t("plan.empty")} />;
  }

  // 默认选最新版本（列表按版本升序，取末位）
  const selected =
    state.data.find((p) => p.version === selectedVersion) ?? state.data[state.data.length - 1];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-40 shrink-0 overflow-y-auto border-r border-border">
        {[...state.data].reverse().map((plan) => (
          <button
            type="button"
            key={plan.version}
            onClick={() => setSelectedVersion(plan.version)}
            className={cn(
              "flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left",
              plan.version === selected?.version ? "bg-surface-active" : "hover:bg-surface-hover",
            )}
          >
            <span className="font-mono text-sm text-fg">
              {t("plan.version", { n: plan.version })}
            </span>
            <StatusBadge status={plan.status} />
          </button>
        ))}
      </div>
      {selected !== undefined ? (
        <PlanBody plan={selected} projectRoot={projectRoot} onApproved={refetch} />
      ) : null}
    </div>
  );
}

/**
 * 计划页（W3.5 / §11.3「我们决定做什么」）：版本列表 + 结构化正文 + 批准。
 * 计划是结构化合同（goal/scope/tasks…），原生分区渲染，不需 Markdown。
 * 版本文本 diff（W3.5b）待补。计划由 Planner 产出（Phase 4），此前显示空态。
 */
export function PlanPage(): ReactElement {
  const { t } = useTranslation();
  const { entry, loading } = useActiveProject();
  return (
    <>
      <PageHeader title={t("nav.plan.label")} description={t("nav.plan.question")} />
      {loading ? (
        <LoadingState variant="detail" />
      ) : entry === null ? (
        <NoActiveProject />
      ) : (
        <PlanView projectRoot={entry.rootPath} />
      )}
    </>
  );
}
