import type { KnowledgeEntryId } from "@ff-pane/shared";
import { type ReactElement, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type {
  KnowledgeEntryView,
  KnowledgeImportReport,
  KnowledgeOverview,
} from "../../../../shared-ipc/contracts";
import { EmptyState } from "../../components/states/EmptyState";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { SearchInput } from "../../components/ui/Input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/Table";
import { Tooltip } from "../../components/ui/Tooltip";
import { invokeQuery } from "../../ipc";
import { formatAbsoluteTime, formatRelativeTime } from "../../lib/time";
import { ImportProgressBar } from "./ImportProgressBar";
import { KnowledgeNoteDialog } from "./KnowledgeNoteDialog";
import { entryIndexState, matchesEntrySearch, sourcePathOf } from "./knowledge-view";
import type { UseKnowledgeImportResult } from "./useKnowledgeImport";

export interface SourcesPanelProps {
  readonly overview: KnowledgeOverview;
  readonly importer: UseKnowledgeImportResult;
  /** 索引变化后刷新总览。 */
  readonly onChanged: () => void;
}

/**
 * 来源管理（§8.3.6）：每个来源的文档数 / 块数 / 索引状态，
 * 支持移除来源（连带删除其索引）与重建索引，以及导出 Markdown。
 *
 * **重建走超危险档确认**：它会把选中来源的块与向量整体重算，
 * 期间该来源检索不到，且重新嵌入是要花钱的（远端 /embeddings 按量计费）。
 */
export function SourcesPanel({ overview, importer, onChanged }: SourcesPanelProps): ReactElement {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<KnowledgeEntryId>>(new Set());
  const [removing, setRemoving] = useState<KnowledgeEntryView | null>(null);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [creating, setCreating] = useState(false);

  const vectorEnabled = overview.vector !== undefined;
  const matched = useMemo(
    () => overview.entries.filter((view) => matchesEntrySearch(view, search)),
    [overview.entries, search],
  );

  const toggle = (id: KnowledgeEntryId): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const reportToast = (report: KnowledgeImportReport | null): void => {
    if (report === null) {
      return;
    }
    onChanged();
    setSelected(new Set());
    if (report.cancelled) {
      toast.info(t("knowledge.importCancelled", { indexed: report.indexed }));
      return;
    }
    toast.success(
      t("knowledge.importDone", {
        indexed: report.indexed,
        skipped: report.skipped,
        chunks: report.chunks,
        embedded: report.embedded,
      }),
    );
    if (report.failures.length > 0) {
      toast.warning(t("knowledge.importFailures", { count: report.failures.length }), {
        description: report.failures
          .slice(0, 3)
          .map((failure) => `${failure.filePath}: ${failure.message}`)
          .join("\n"),
      });
    }
    if (report.embedFatal !== undefined) {
      toast.error(t("knowledge.embedFatal"), { description: report.embedFatal });
    }
  };

  const remove = async (view: KnowledgeEntryView): Promise<void> => {
    const settled = await invokeQuery("knowledge:remove-entry", { id: view.entry.id });
    setRemoving(null);
    if (settled.status === "error") {
      toast.error(t("knowledge.removeError"), { description: settled.error.message });
      return;
    }
    onChanged();
    toast.success(t("knowledge.removed", { title: view.entry.title }));
  };

  const exportSelected = async (): Promise<void> => {
    const settled = await invokeQuery("knowledge:export", { entryIds: [...selected] });
    if (settled.status === "error") {
      toast.error(t("knowledge.exportError"), { description: settled.error.message });
      return;
    }
    if (settled.data.cancelled) {
      return;
    }
    toast.success(t("knowledge.exported", { count: settled.data.entries }), {
      description: settled.data.path,
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="md"
          disabled={importer.running}
          onClick={() => void importer.importPaths("files").then(reportToast)}
        >
          {t("knowledge.importFiles")}
        </Button>
        <Button
          variant="secondary"
          size="md"
          disabled={importer.running}
          onClick={() => void importer.importPaths("directory").then(reportToast)}
        >
          {t("knowledge.importDirectory")}
        </Button>
        <Button variant="secondary" size="md" onClick={() => setCreating(true)}>
          {t("knowledge.newEntry")}
        </Button>
        <Button
          variant="secondary"
          size="md"
          disabled={importer.running || overview.entries.length === 0}
          onClick={() => setConfirmRebuild(true)}
        >
          {selected.size > 0
            ? t("knowledge.rebuildSelected", { count: selected.size })
            : t("knowledge.rebuildAll")}
        </Button>
        <Button
          variant="ghost"
          size="md"
          disabled={overview.entries.length === 0}
          onClick={() => void exportSelected()}
        >
          {selected.size > 0
            ? t("knowledge.exportSelected", { count: selected.size })
            : t("knowledge.exportAll")}
        </Button>
      </div>

      <StatsBar overview={overview} />

      {importer.progress !== null ? (
        <ImportProgressBar progress={importer.progress} onCancel={importer.cancel} />
      ) : null}

      {overview.entries.length === 0 ? (
        <EmptyState
          className="min-h-0 flex-1"
          message={t("knowledge.emptySources")}
          action={{
            label: t("knowledge.importDirectory"),
            onClick: () => void importer.importPaths("directory").then(reportToast),
          }}
        />
      ) : (
        <>
          <SearchInput
            value={search}
            className="shrink-0"
            iconLabel={t("knowledge.sourcesSearchLabel")}
            placeholder={t("knowledge.sourcesSearchPlaceholder")}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>{t("knowledge.column.title")}</TableHead>
                  <TableHead>{t("knowledge.column.format")}</TableHead>
                  <TableHead align="right">{t("knowledge.column.chunks")}</TableHead>
                  <TableHead>{t("knowledge.column.state")}</TableHead>
                  <TableHead>{t("knowledge.column.importedAt")}</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {matched.map((view) => (
                  <EntryRow
                    key={view.entry.id}
                    view={view}
                    vectorEnabled={vectorEnabled}
                    selected={selected.has(view.entry.id)}
                    onToggle={() => toggle(view.entry.id)}
                    onRemove={() => setRemoving(view)}
                  />
                ))}
              </TableBody>
            </Table>
            {matched.length === 0 ? (
              <EmptyState className="min-h-0" message={t("knowledge.noMatchingSource")} />
            ) : null}
          </div>
        </>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
          }
        }}
        title={t("knowledge.removeTitle", { title: removing?.entry.title ?? "" })}
        description={t("knowledge.removeDescription")}
        confirmLabel={t("knowledge.remove")}
        onConfirm={() => {
          if (removing !== null) {
            void remove(removing);
          }
        }}
      />

      <ConfirmDialog
        open={confirmRebuild}
        onOpenChange={setConfirmRebuild}
        tone="primary"
        title={
          selected.size > 0
            ? t("knowledge.rebuildSelectedTitle", { count: selected.size })
            : t("knowledge.rebuildAllTitle")
        }
        description={t("knowledge.rebuildDescription")}
        confirmLabel={t("knowledge.rebuild")}
        onConfirm={() => {
          setConfirmRebuild(false);
          void importer
            .rebuild(selected.size > 0 ? { entryIds: [...selected] } : undefined)
            .then(reportToast);
        }}
      />

      <KnowledgeNoteDialog open={creating} onOpenChange={setCreating} onCreated={onChanged} />
    </div>
  );
}

/** 全库统计 + 向量索引状态（§8.3.6「文档数、块数、索引状态」的全局那一行）。 */
function StatsBar({ overview }: { readonly overview: KnowledgeOverview }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 text-2xs text-fg-muted">
      <span>{t("knowledge.stats.documents", { count: overview.entries.length })}</span>
      <span>{t("knowledge.stats.chunks", { count: overview.totalChunks })}</span>
      {overview.vector === undefined ? (
        <Badge>{t("knowledge.recall.keywordOnly")}</Badge>
      ) : (
        <Tooltip
          content={t("knowledge.stats.vectorDetail", {
            backend: overview.vector.backend,
            dimensions: overview.vector.dimensions,
            model: overview.vector.model,
          })}
          wrapTrigger
        >
          <span>
            <Badge tone="primary">
              {t("knowledge.stats.vectors", {
                vectors: overview.vector.vectors,
                total: overview.totalChunks,
              })}
            </Badge>
          </span>
        </Tooltip>
      )}
      {overview.embedding.available ? (
        <span>
          {t("knowledge.stats.embedder", {
            provider: overview.embedding.providerName,
            model: overview.embedding.model,
          })}
        </span>
      ) : (
        <span>
          {t(`knowledge.blocker.${overview.embedding.blocker}`)}
          {overview.embedding.detail === undefined ? null : ` (${overview.embedding.detail})`}
        </span>
      )}
    </div>
  );
}

function EntryRow({
  view,
  vectorEnabled,
  selected,
  onToggle,
  onRemove,
}: {
  readonly view: KnowledgeEntryView;
  readonly vectorEnabled: boolean;
  readonly selected: boolean;
  readonly onToggle: () => void;
  readonly onRemove: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const state = entryIndexState(view, vectorEnabled);
  const sourcePath = sourcePathOf(view.entry);
  return (
    <TableRow selected={selected}>
      <TableCell>
        <input
          type="checkbox"
          checked={selected}
          aria-label={t("knowledge.selectSource", { title: view.entry.title })}
          onChange={onToggle}
        />
      </TableCell>
      <TableCell truncate>
        <Tooltip content={sourcePath ?? view.entry.title} wrapTrigger>
          <span className="truncate">{view.entry.title}</span>
        </Tooltip>
      </TableCell>
      <TableCell>{t(`knowledge.format.${view.entry.format}`)}</TableCell>
      <TableCell align="right" mono>
        {view.chunkCount}
      </TableCell>
      <TableCell>
        <Badge tone={state === "partial" ? "warning" : "neutral"}>
          {state === "partial"
            ? t("knowledge.state.partial", {
                embedded: view.embeddedCount,
                total: view.chunkCount,
              })
            : t(`knowledge.state.${state}`)}
        </Badge>
      </TableCell>
      {/* §6.5：列表给相对时间，hover 给绝对时间 */}
      <TableCell>
        <Tooltip content={formatAbsoluteTime(view.entry.importedAt, i18n.language)} wrapTrigger>
          <span>{formatRelativeTime(view.entry.importedAt, i18n.language)}</span>
        </Tooltip>
      </TableCell>
      <TableCell align="right">
        <Button variant="ghost" size="sm" onClick={onRemove}>
          {t("knowledge.remove")}
        </Button>
      </TableCell>
    </TableRow>
  );
}
