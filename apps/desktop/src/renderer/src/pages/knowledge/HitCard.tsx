import type { KnowledgeChunk } from "@ff-pane/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KnowledgeHitView } from "../../../../shared-ipc/contracts";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Tooltip } from "../../components/ui/Tooltip";
import { formatProvenanceTrail, PROVENANCE_SEPARATOR } from "./knowledge-view";

/** 上下文扩展块：与命中块同一排版但降一级，一眼能分出哪块才是命中的。 */
function ContextChunks({ chunks }: { readonly chunks: readonly KnowledgeChunk[] }): ReactElement {
  return (
    <div className="flex flex-col gap-1.5 border-l-2 border-border pl-2">
      {chunks.map((chunk) => (
        <p key={chunk.id} className="text-xs whitespace-pre-wrap text-fg-muted select-text">
          {chunk.text}
        </p>
      ))}
    </div>
  );
}

export interface HitCardProps {
  readonly hit: KnowledgeHitView;
  /** 行内操作（发送到会话 / 复制引用 / 插入）。 */
  readonly actions?: ReactNode;
  /** 勾选态；提供 onToggle 才渲染复选框。 */
  readonly selected?: boolean;
  readonly onToggle?: (selected: boolean) => void;
}

/**
 * 一条检索命中（§8.3.4「命中块 + 上下文扩展 + 出处」）。
 *
 * 上下文扩展**默认折叠**：它的作用是「这一块前后在讲什么」，属于按需查证，
 * 默认展开会让一屏放不下三条结果，反而看不清命中本身。
 *
 * 命中来源徽章（关键词 / 语义）如实标出走了哪一路——两路都命中时通常最可信，
 * 而只有关键词路时用户至少知道「现在没在做语义检索」。
 */
export function HitCard({ hit, actions, selected, onToggle }: HitCardProps): ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasContext = hit.before.length > 0 || hit.after.length > 0;
  const pageLabel =
    hit.chunk.provenance.page === undefined
      ? undefined
      : t("knowledge.page", { page: hit.chunk.provenance.page });
  const trail = formatProvenanceTrail(hit, pageLabel);

  return (
    <article className="flex flex-col gap-2 rounded-sm border border-border bg-surface p-3">
      <header className="flex items-start gap-2">
        {onToggle !== undefined ? (
          <input
            type="checkbox"
            className="mt-1"
            checked={selected === true}
            aria-label={t("knowledge.selectHit", { title: hit.entryTitle })}
            onChange={(event) => onToggle(event.target.checked)}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-fg">{hit.entryTitle}</span>
            <Badge>{t(`knowledge.format.${hit.entryFormat}`)}</Badge>
            {hit.sources.includes("vector") ? (
              <Badge tone="primary">{t("knowledge.source.vector")}</Badge>
            ) : null}
            {hit.sources.includes("fts") || hit.sources.includes("like-fallback") ? (
              <Badge tone="neutral">{t("knowledge.source.keyword")}</Badge>
            ) : null}
          </div>
          <Tooltip content={hit.chunk.provenance.filePath} wrapTrigger>
            <span className="truncate text-2xs text-fg-subtle">
              {trail.join(PROVENANCE_SEPARATOR)}
            </span>
          </Tooltip>
        </div>
        {actions !== undefined ? (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        ) : null}
      </header>

      {/* 上下文块排在命中块的实际前后位置：它们的意义就是「这一块前面/后面在讲什么」，
          堆到一起会让人读不出顺序 */}
      {expanded ? <ContextChunks chunks={hit.before} /> : null}
      <p className="text-sm whitespace-pre-wrap text-fg select-text">{hit.chunk.text}</p>
      {expanded ? <ContextChunks chunks={hit.after} /> : null}

      {hasContext ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? (
            <ChevronDown aria-hidden size={14} />
          ) : (
            <ChevronRight aria-hidden size={14} />
          )}
          {t("knowledge.context", { count: hit.before.length + hit.after.length })}
        </Button>
      ) : null}
    </article>
  );
}
