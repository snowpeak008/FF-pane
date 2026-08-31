import { KNOWLEDGE_FORMATS, type KnowledgeFormat } from "@ff-pane/shared";
import { type FormEvent, type ReactElement, type ReactNode, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  KnowledgeHitView,
  KnowledgeSearchFilters,
  KnowledgeSearchResponse,
} from "../../../../shared-ipc/contracts";
import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import { InlineLoading } from "../../components/states/LoadingState";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { SearchInput } from "../../components/ui/Input";
import { type IpcErrorInfo, invokeQuery } from "../../ipc";
import { HitCard } from "./HitCard";
import type { KnowledgeFilterOptions } from "./knowledge-view";

/** 检索面板的一次查询状态。空闲 = 还没搜过（不是"没有结果"，两者的空态文案不同）。 */
type SearchState =
  | { readonly kind: "idle" }
  | { readonly kind: "searching" }
  | { readonly kind: "done"; readonly response: KnowledgeSearchResponse }
  | { readonly kind: "error"; readonly error: IpcErrorInfo };

export interface SearchPanelProps {
  /** 可选过滤项（由条目集合派生）。 */
  readonly options: KnowledgeFilterOptions;
  /** 每条命中的行内操作。 */
  readonly hitActions?: (hit: KnowledgeHitView) => ReactNode;
  /** 面板顶部的附加说明（如"未配嵌入模型"提示）。 */
  readonly notice?: ReactNode;
  /** 结果条数上限。 */
  readonly limit?: number;
  /** 自动聚焦查询框（对话框里用）。 */
  readonly autoFocus?: boolean;
}

/**
 * 混合检索面板（§8.3.4）。知识库页与会话页的「从知识库插入」共用同一个组件——
 * 两处要的是同一件事（查、看出处、挑一条），只是挑完之后的去处不同，
 * 那个差异由 hitActions 注入即可，没必要维护两套检索界面。
 *
 * **过滤是折叠的**：四个维度全摊开会把结果挤到屏幕外，而绝大多数检索不需要过滤。
 */
export function SearchPanel({
  options,
  hitActions,
  notice,
  limit,
  autoFocus,
}: SearchPanelProps): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [showFilters, setShowFilters] = useState(false);
  const [formats, setFormats] = useState<readonly KnowledgeFormat[]>([]);
  const [tags, setTags] = useState<readonly string[]>([]);
  const [directory, setDirectory] = useState("");

  const search = useCallback(async () => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "searching" });
    const filters: KnowledgeSearchFilters = {
      ...(formats.length === 0 ? {} : { formats }),
      ...(tags.length === 0 ? {} : { tags }),
      ...(directory === "" ? {} : { sourcePathPrefix: directory }),
    };
    const settled = await invokeQuery("knowledge:search", {
      query: trimmed,
      ...(Object.keys(filters).length === 0 ? {} : { filters }),
      ...(limit === undefined ? {} : { limit }),
    });
    setState(
      settled.status === "error"
        ? { kind: "error", error: settled.error }
        : { kind: "done", response: settled.data },
    );
  }, [directory, formats, limit, query, tags]);

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void search();
  };

  const toggle = <T,>(list: readonly T[], value: T): readonly T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <form className="flex shrink-0 items-center gap-2" onSubmit={onSubmit}>
        <SearchInput
          value={query}
          // 对话框里检索框是唯一入口，不聚焦等于让用户多点一次
          autoFocus={autoFocus === true}
          iconLabel={t("knowledge.searchLabel")}
          placeholder={t("knowledge.searchPlaceholder")}
          className="flex-1"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" variant="primary" size="md" disabled={query.trim() === ""}>
          {t("knowledge.search")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="md"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((prev) => !prev)}
        >
          {t("knowledge.filters")}
        </Button>
      </form>

      {showFilters ? (
        <div className="flex shrink-0 flex-col gap-2 rounded-sm border border-border bg-surface-sunken p-2">
          <FilterRow label={t("knowledge.filter.format")}>
            {KNOWLEDGE_FORMATS.filter((format) => options.formats.includes(format)).map(
              (format) => (
                <FilterChip
                  key={format}
                  active={formats.includes(format)}
                  label={t(`knowledge.format.${format}`)}
                  onClick={() => setFormats((prev) => toggle(prev, format))}
                />
              ),
            )}
          </FilterRow>
          {options.tags.length > 0 ? (
            <FilterRow label={t("knowledge.filter.tag")}>
              {options.tags.map((tag) => (
                <FilterChip
                  key={tag}
                  active={tags.includes(tag)}
                  label={tag}
                  onClick={() => setTags((prev) => toggle(prev, tag))}
                />
              ))}
            </FilterRow>
          ) : null}
          {options.directories.length > 0 ? (
            <FilterRow label={t("knowledge.filter.directory")}>
              {options.directories.map((dir) => (
                <FilterChip
                  key={dir}
                  active={directory === dir}
                  label={dir}
                  onClick={() => setDirectory((prev) => (prev === dir ? "" : dir))}
                />
              ))}
            </FilterRow>
          ) : null}
        </div>
      ) : null}

      {notice}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Results
          state={state}
          {...(hitActions === undefined ? {} : { hitActions })}
          onRetry={() => void search()}
        />
      </div>
    </div>
  );
}

function FilterRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex items-start gap-2">
      <span className="w-16 shrink-0 pt-1 text-2xs text-fg-muted">{label}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <Button
      type="button"
      variant={active ? "primary" : "ghost"}
      size="sm"
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

/** 结果区：四态（未搜 / 搜索中 / 出错 / 已出结果，其中已出结果又分空与非空）。 */
function Results({
  state,
  hitActions,
  onRetry,
}: {
  readonly state: SearchState;
  readonly hitActions?: (hit: KnowledgeHitView) => ReactNode;
  readonly onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  if (state.kind === "idle") {
    return <EmptyState className="min-h-0" message={t("knowledge.searchIdle")} />;
  }
  if (state.kind === "searching") {
    return <InlineLoading label={t("knowledge.searching")} />;
  }
  if (state.kind === "error") {
    return (
      <ErrorState
        className="min-h-0"
        summary={t("knowledge.searchError")}
        error={state.error}
        onRetry={onRetry}
      />
    );
  }
  if (state.response.hits.length === 0) {
    return <EmptyState className="min-h-0" message={t("knowledge.searchEmpty")} />;
  }
  return (
    <div className="flex flex-col gap-2">
      <RecallSummary response={state.response} />
      {state.response.hits.map((hit) => (
        <HitCard key={hit.chunk.id} hit={hit} actions={hitActions?.(hit)} />
      ))}
    </div>
  );
}

/**
 * 本次实际走了哪几路召回。
 * 如实呈现是必要的：只走了关键词路时，用户看到的排序与「语义检索」是两回事，
 * 不说清楚会让他以为语义检索没效果，而不是根本没启用。
 */
function RecallSummary({ response }: { readonly response: KnowledgeSearchResponse }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-2xs text-fg-subtle">
      <span>{t("knowledge.hits", { count: response.hits.length })}</span>
      {response.usedVector ? (
        <Badge tone="primary">{t("knowledge.recall.hybrid")}</Badge>
      ) : (
        <Badge>{t("knowledge.recall.keywordOnly")}</Badge>
      )}
      {response.usedFts ? null : <Badge tone="warning">{t("knowledge.recall.likeFallback")}</Badge>}
      {response.usedVector && !response.vectorPrefilterExact ? (
        <Badge tone="warning">{t("knowledge.recall.approximate")}</Badge>
      ) : null}
      {response.embeddingBlocker !== undefined ? (
        <span>{t(`knowledge.blocker.${response.embeddingBlocker}`)}</span>
      ) : null}
    </div>
  );
}
