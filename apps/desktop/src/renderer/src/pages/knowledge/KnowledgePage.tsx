import { type ReactElement, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { KnowledgeHitView, KnowledgeOverview } from "../../../../shared-ipc/contracts";
import { ErrorState } from "../../components/states/ErrorState";
import { LoadingState } from "../../components/states/LoadingState";
import { Button } from "../../components/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/Tabs";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { PageHeader } from "../../layout/PageHeader";
import { useSessionStore } from "../../stores/session";
import { AgentToolPanel } from "./AgentToolPanel";
import { buildKnowledgeCitation, deriveFilterOptions } from "./knowledge-view";
import { SearchPanel } from "./SearchPanel";
import { SourcesPanel } from "./SourcesPanel";
import { useKnowledgeImport } from "./useKnowledgeImport";

/**
 * 知识库页（T6.5 / §11.7「我能查到什么资料」）：检索 + 来源管理两个标签。
 *
 * **作用域是全局而不是当前项目**：知识库与共享记忆一样跨项目复用（§10.1 落在
 * `~/.aiworkbench` 下），故本页不需要当前项目，也不显示 NoActiveProject 空态。
 * 只有「发送到当前会话」这一个动作与项目/会话有关，那由会话页自己处理。
 */
function KnowledgeView({
  overview,
  refetch,
}: {
  readonly overview: KnowledgeOverview;
  readonly refetch: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const appendDraft = useSessionStore((state) => state.appendComposerDraft);
  const options = useMemo(() => deriveFilterOptions(overview.entries), [overview.entries]);
  const importer = useKnowledgeImport({
    onError: (summary, message) => {
      toast.error(t(summary === "import" ? "knowledge.importError" : "knowledge.rebuildError"), {
        description: message,
      });
    },
  });

  /** 命中 → 带出处引用的文本（§8.3.5「自动附带出处引用」）。 */
  const citationOf = (hit: KnowledgeHitView): string =>
    buildKnowledgeCitation(hit, {
      sourceLabel: t("knowledge.citationSource"),
      ...(hit.chunk.provenance.page === undefined
        ? {}
        : { pageLabel: t("knowledge.page", { page: hit.chunk.provenance.page }) }),
    });

  const sendToSession = (hit: KnowledgeHitView): void => {
    // 追加到草稿而不是覆盖：用户很可能已经写了半句话，正等着把资料垫进去
    appendDraft(citationOf(hit));
    toast.success(t("knowledge.sentToSession"));
    void navigate("/session");
  };

  const copyCitation = (hit: KnowledgeHitView): void => {
    void navigator.clipboard.writeText(citationOf(hit)).then(() => {
      toast.success(t("common.copied"));
    });
  };

  return (
    <Tabs defaultValue="search" className="flex min-h-0 flex-1 flex-col p-4">
      <TabsList>
        <TabsTrigger value="search">{t("knowledge.tab.search")}</TabsTrigger>
        <TabsTrigger value="sources">
          {t("knowledge.tab.sources")}
          {overview.entries.length > 0 ? (
            <span className="ml-1 text-2xs text-fg-subtle">({overview.entries.length})</span>
          ) : null}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="search" className="flex min-h-0 flex-1 flex-col pt-3">
        <SearchPanel
          options={options}
          hitActions={(hit) => (
            <>
              <Button variant="primary" size="sm" onClick={() => sendToSession(hit)}>
                {t("knowledge.sendToSession")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => copyCitation(hit)}>
                {t("knowledge.copyCitation")}
              </Button>
            </>
          )}
        />
      </TabsContent>

      <TabsContent value="sources" className="flex min-h-0 flex-1 flex-col gap-3 pt-3">
        {/* Agent 只读检索工具开关（T6.6）：项目级、默认关，放在来源标签下 ——
            它回答的是"这批资料要不要让 Agent 自己查"，与来源管理是同一件事的两面。 */}
        <AgentToolPanel />
        <SourcesPanel overview={overview} importer={importer} onChanged={refetch} />
      </TabsContent>
    </Tabs>
  );
}

export function KnowledgePage(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("knowledge:list");
  return (
    <>
      <PageHeader title={t("nav.knowledge.label")} description={t("nav.knowledge.question")} />
      {state.status === "error" ? (
        <ErrorState
          summary={t("knowledge.loadError")}
          error={state.error}
          onRetry={refetch}
          className="min-h-0"
        />
      ) : state.status === "success" ? (
        <KnowledgeView overview={state.data} refetch={refetch} />
      ) : (
        <LoadingState variant="table" />
      )}
    </>
  );
}
