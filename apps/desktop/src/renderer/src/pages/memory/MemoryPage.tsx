import type { MemoryEntry } from "@ff-pane/shared";
import { type ReactElement, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import { LoadingState } from "../../components/states/LoadingState";
import { Button } from "../../components/ui/Button";
import { SearchInput } from "../../components/ui/Input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/Tabs";
import { useActiveProject } from "../../hooks/useActiveProject";
import { invokeQuery } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { PageHeader } from "../../layout/PageHeader";
import { NoActiveProject } from "../NoActiveProject";
import { EditCandidateDialog } from "./EditCandidateDialog";
import { HabitsPanel } from "./HabitsPanel";
import { MemoryEntryCard } from "./MemoryEntryCard";
import { groupByCategory, MEMORY_CATEGORY_ORDER, matchesMemorySearch } from "./memory-view";

function MemoryView({ projectRoot }: { readonly projectRoot: string }): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("memory:list", { projectRoot });
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const withBusy = useCallback(
    async (id: string, run: () => Promise<boolean>): Promise<boolean> => {
      setBusyIds((prev) => new Set(prev).add(id));
      const ok = await run();
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return ok;
    },
    [],
  );

  const restore = useCallback(
    async (entry: MemoryEntry) => {
      const settled = await invokeQuery("memory:update", { projectRoot, entry });
      if (settled.status === "error") {
        toast.error(t("memory.restoreError"), { description: settled.error.message });
        return;
      }
      refetch();
    },
    [projectRoot, refetch, t],
  );

  const approve = useCallback(
    (entry: MemoryEntry) => {
      void withBusy(entry.id, async () => {
        const settled = await invokeQuery("memory:approve", { projectRoot, id: entry.id });
        if (settled.status === "error") {
          toast.error(t("memory.approveError"), { description: settled.error.message });
          return false;
        }
        refetch();
        toast.success(t("memory.approved", { title: entry.title }));
        return true;
      });
    },
    [projectRoot, refetch, t, withBusy],
  );

  const reject = useCallback(
    (entry: MemoryEntry) => {
      void withBusy(entry.id, async () => {
        const settled = await invokeQuery("memory:reject", { projectRoot, id: entry.id });
        if (settled.status === "error") {
          toast.error(t("memory.rejectError"), { description: settled.error.message });
          return false;
        }
        refetch();
        // 可撤销（§6.3 拒绝候选）：删除的是整条，撤销 = 原样重存
        toast.success(t("memory.rejected", { title: entry.title }), {
          action: { label: t("common.undo"), onClick: () => void restore(entry) },
        });
        return true;
      });
    },
    [projectRoot, refetch, restore, t, withBusy],
  );

  if (state.status === "error") {
    return (
      <ErrorState
        summary={t("memory.loadError")}
        error={state.error}
        onRetry={refetch}
        className="min-h-0"
      />
    );
  }
  if (state.status !== "success") {
    return <LoadingState variant="list" />;
  }

  const matched = state.data.filter((e) => matchesMemorySearch(e, search));
  const active = matched.filter((e) => e.status === "active");
  const candidates = matched.filter((e) => e.status === "candidate");
  const groups = groupByCategory(active);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3 p-4">
      <SearchInput
        value={search}
        iconLabel={t("memory.searchLabel")}
        placeholder={t("memory.searchPlaceholder")}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Tabs defaultValue="project" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="project">{t("memory.tab.project")}</TabsTrigger>
          <TabsTrigger value="shared">{t("memory.tab.shared")}</TabsTrigger>
          <TabsTrigger value="candidates">
            {t("memory.tab.candidates")}
            {candidates.length > 0 ? (
              <span className="ml-1 text-2xs text-fg-subtle">({candidates.length})</span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="project" className="min-h-0 flex-1 overflow-y-auto">
          {active.length === 0 ? (
            <EmptyState className="min-h-0 flex-1" message={t("memory.emptyProject")} />
          ) : (
            <div className="flex flex-col gap-4 pt-3">
              {MEMORY_CATEGORY_ORDER.filter((cat) => groups[cat].length > 0).map((cat) => (
                <section key={cat} className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-fg-muted">
                    {t(`memory.category.${cat}`)}
                  </h3>
                  {groups[cat].map((entry) => (
                    <MemoryEntryCard key={entry.id} entry={entry} />
                  ))}
                </section>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="shared" className="min-h-0 flex-1 overflow-y-auto">
          <HabitsPanel search={search} />
        </TabsContent>

        <TabsContent value="candidates" className="min-h-0 flex-1 overflow-y-auto">
          {candidates.length === 0 ? (
            <EmptyState className="min-h-0 flex-1" message={t("memory.emptyCandidates")} />
          ) : (
            <div className="flex flex-col gap-2 pt-3">
              {candidates.map((entry) => (
                <MemoryEntryCard
                  key={entry.id}
                  entry={entry}
                  actions={
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busyIds.has(entry.id)}
                        onClick={() => approve(entry)}
                      >
                        {t("memory.approve")}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyIds.has(entry.id)}
                        onClick={() => setEditing(entry)}
                      >
                        {t("memory.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyIds.has(entry.id)}
                        onClick={() => reject(entry)}
                      >
                        {t("memory.reject")}
                      </Button>
                    </>
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <EditCandidateDialog
        projectRoot={projectRoot}
        entry={editing}
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

/**
 * 记忆页（W3.8 / §11.6「项目记住了什么」）：项目记忆 / 共享记忆（占位）/ 候选三标签，
 * 类别分组 + 搜索 + 候选审核（通过 / 编辑后通过 / 拒绝）。以当前项目为作用域。
 */
export function MemoryPage(): ReactElement {
  const { t } = useTranslation();
  const { entry, loading } = useActiveProject();
  return (
    <>
      <PageHeader title={t("nav.memory.label")} description={t("nav.memory.question")} />
      {loading ? (
        <LoadingState variant="list" />
      ) : entry === null ? (
        <NoActiveProject />
      ) : (
        <MemoryView projectRoot={entry.rootPath} />
      )}
    </>
  );
}
