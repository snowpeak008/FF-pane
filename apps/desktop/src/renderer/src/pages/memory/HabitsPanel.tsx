import type { HabitEntry } from "@ff-pane/shared";
import { Plus } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import { LoadingState } from "../../components/states/LoadingState";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { invokeQuery } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { HabitEditDialog } from "./HabitEditDialog";
import {
  groupHabitsByCategory,
  HABIT_CATEGORY_ORDER,
  HABIT_SOFT_LIMIT_WARN_AT,
  matchesHabitSearch,
  sortHabitsForDisplay,
} from "./habits-view";

/**
 * 共享记忆（习惯档案）管理面板（T5.1，§8.2）——记忆页「共享记忆」标签的内容。
 * 习惯是全局共享记忆（跨项目），故直接查询 habits:list，不依赖当前项目。
 * 覆盖：手写新增（来源一）+ 按类分组浏览 + 编辑 / 停用 / 删除 + 候选审核（来源二/三）。
 */
export function HabitsPanel({ search }: { readonly search: string }): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("habits:list");
  const [editing, setEditing] = useState<{ readonly entry: HabitEntry | null } | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const withBusy = useCallback(async (id: string, run: () => Promise<void>): Promise<void> => {
    setBusyIds((prev) => new Set(prev).add(id));
    await run();
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggleEnabled = useCallback(
    (entry: HabitEntry) =>
      void withBusy(entry.id, async () => {
        const settled = await invokeQuery("habits:set-enabled", {
          id: entry.id,
          enabled: !entry.enabled,
        });
        if (settled.status === "error") {
          toast.error(t("habit.toggleError"), { description: settled.error.message });
          return;
        }
        refetch();
      }),
    [refetch, t, withBusy],
  );

  const approve = useCallback(
    (entry: HabitEntry) =>
      void withBusy(entry.id, async () => {
        const settled = await invokeQuery("habits:approve", { id: entry.id });
        if (settled.status === "error") {
          toast.error(t("habit.approveError"), { description: settled.error.message });
          return;
        }
        refetch();
        toast.success(t("habit.approved"));
      }),
    [refetch, t, withBusy],
  );

  const remove = useCallback(
    (entry: HabitEntry) =>
      void withBusy(entry.id, async () => {
        const settled = await invokeQuery("habits:reject", { id: entry.id });
        if (settled.status === "error") {
          toast.error(t("habit.deleteError"), { description: settled.error.message });
          return;
        }
        refetch();
        // 可撤销：删除的是整条，撤销 = 以原字段重建（新 id）
        toast.success(t("habit.deleted"), {
          action: {
            label: t("common.undo"),
            onClick: () => {
              void invokeQuery("habits:create", {
                draft: {
                  category: entry.category,
                  content: entry.content,
                  status: entry.status,
                  enabled: entry.enabled,
                  source: entry.source,
                  importance: entry.importance,
                },
              }).then(() => refetch());
            },
          },
        });
      }),
    [refetch, t, withBusy],
  );

  if (state.status === "error") {
    return (
      <ErrorState
        summary={t("habit.loadError")}
        error={state.error}
        onRetry={refetch}
        className="min-h-0"
      />
    );
  }
  if (state.status !== "success") {
    return <LoadingState variant="list" />;
  }

  const matched = state.data.filter((h) => matchesHabitSearch(h, search));
  const active = matched.filter((h) => h.status === "active");
  const candidates = matched.filter((h) => h.status === "candidate");
  const groups = groupHabitsByCategory(active);
  const total = state.data.filter((h) => h.status !== "archived").length;
  const nearLimit = total >= HABIT_SOFT_LIMIT_WARN_AT;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 pt-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-fg-muted">{t("habit.intro")}</p>
        <Button variant="primary" size="sm" onClick={() => setEditing({ entry: null })}>
          <Plus size={14} aria-hidden />
          {t("habit.add")}
        </Button>
      </div>

      {nearLimit ? (
        <p className="rounded-md bg-warning-surface px-2 py-1 text-2xs text-warning-text">
          {t("habit.nearLimit", { count: total })}
        </p>
      ) : null}

      {candidates.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-fg-muted">
            {t("habit.candidatesHeading")}
            <span className="ml-1 text-2xs text-fg-subtle">({candidates.length})</span>
          </h3>
          {candidates.map((entry) => (
            <HabitRow
              key={entry.id}
              entry={entry}
              busy={busyIds.has(entry.id)}
              onEdit={() => setEditing({ entry })}
              onDelete={() => remove(entry)}
              onApprove={() => approve(entry)}
            />
          ))}
        </section>
      ) : null}

      {active.length === 0 && candidates.length === 0 ? (
        <EmptyState className="min-h-0 flex-1" message={t("habit.empty")} />
      ) : (
        <div className="flex flex-col gap-4">
          {HABIT_CATEGORY_ORDER.filter((cat) => groups[cat].length > 0).map((cat) => (
            <section key={cat} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-fg-muted">{t(`habit.category.${cat}`)}</h3>
              {sortHabitsForDisplay(groups[cat]).map((entry) => (
                <HabitRow
                  key={entry.id}
                  entry={entry}
                  busy={busyIds.has(entry.id)}
                  onEdit={() => setEditing({ entry })}
                  onDelete={() => remove(entry)}
                  onToggle={() => toggleEnabled(entry)}
                />
              ))}
            </section>
          ))}
        </div>
      )}

      <HabitEditDialog
        editing={editing}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
          }
        }}
        onSaved={refetch}
      />
    </div>
  );
}

interface HabitRowProps {
  readonly entry: HabitEntry;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onToggle?: () => void;
  readonly onApprove?: () => void;
}

function HabitRow({
  entry,
  busy,
  onEdit,
  onDelete,
  onToggle,
  onApprove,
}: HabitRowProps): ReactElement {
  const { t } = useTranslation();
  return (
    <Card padding="compact" className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p
          className={`whitespace-pre-wrap text-sm select-text ${entry.enabled ? "text-fg" : "text-fg-subtle line-through"}`}
        >
          {entry.content}
        </p>
        <div className="flex items-center gap-1.5 pt-0.5">
          <Badge>{t(`habit.source.${entry.source.kind}`)}</Badge>
          <span className="text-2xs text-fg-subtle">
            {t("habit.importanceLabel", { value: entry.importance })}
          </span>
          {!entry.enabled ? (
            <span className="text-2xs text-fg-subtle">{t("habit.disabled")}</span>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1">
        {onApprove !== undefined ? (
          <Button variant="primary" size="sm" disabled={busy} onClick={onApprove}>
            {t("habit.approve")}
          </Button>
        ) : null}
        {onToggle !== undefined ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onToggle}>
            {entry.enabled ? t("habit.disable") : t("habit.enable")}
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" disabled={busy} onClick={onEdit}>
          {t("habit.edit")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onDelete}>
          {t("habit.delete")}
        </Button>
      </div>
    </Card>
  );
}
