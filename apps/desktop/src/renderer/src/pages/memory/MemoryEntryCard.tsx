import type { MemoryEntry } from "@ff-pane/shared";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { formatAbsoluteTime, formatRelativeTime } from "../../lib/time";

export interface MemoryEntryCardProps {
  readonly entry: MemoryEntry;
  /** 底部操作区（候选审核时传入通过/编辑/拒绝；只读展示时省略）。 */
  readonly actions?: ReactNode;
}

/**
 * 记忆条目卡片（W3.8 / §8.1）：类别徽章 + 置信度 + 更新时间 → 标题 → 正文。
 * 正文为 Markdown（§8.1），Phase 3 先保留换行纯文本渲染，富渲染随会话/计划页统一接入。
 */
export function MemoryEntryCard({ entry, actions }: MemoryEntryCardProps): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  return (
    <Card padding="compact" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Badge>{t(`memory.category.${entry.category}`)}</Badge>
        <span className="text-2xs text-fg-subtle">
          {t(`memory.confidence.${entry.confidence}`)}
        </span>
        <span
          className="ml-auto font-mono text-2xs text-fg-subtle"
          title={formatAbsoluteTime(entry.updatedAt, locale)}
        >
          {formatRelativeTime(entry.updatedAt, locale)}
        </span>
      </div>
      <p className="text-sm font-medium text-fg select-text">{entry.title}</p>
      <p className="line-clamp-4 whitespace-pre-wrap text-sm text-fg-muted select-text">
        {entry.body}
      </p>
      {actions !== undefined ? (
        <div className="flex items-center gap-1 pt-0.5">{actions}</div>
      ) : null}
    </Card>
  );
}
