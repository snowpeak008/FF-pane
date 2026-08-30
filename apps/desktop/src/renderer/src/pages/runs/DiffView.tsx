import type { ReactElement } from "react";
import { cn } from "../../lib/cn";
import { classifyDiffLine, type DiffLineKind } from "./diff-lines";

/** 行类型 → 底色/文字类（§3.5：正文 text-fg，增删语义靠底色 + 行首标记）。 */
const KIND_CLASS: Readonly<Record<DiffLineKind, string>> = {
  added: "bg-diff-added-bg text-fg",
  removed: "bg-diff-removed-bg text-fg",
  hunk: "bg-diff-hunk-bg text-diff-hunk-text",
  meta: "text-fg-subtle",
  context: "text-fg",
};

export interface DiffViewProps {
  /** unified diff 文本。 */
  readonly diff: string;
}

/**
 * 统一 diff 着色视图（W3.7 / 设计系统 §3.5）。可复用于计划版本 diff（W3.5b）。
 * 逐行渲染，行内可横向滚动；不做词级高亮（Phase 3 先给行级，足够看清改动）。
 */
export function DiffView({ diff }: DiffViewProps): ReactElement {
  const lines = diff.split("\n");
  return (
    <div className="overflow-x-auto rounded-sm border border-border bg-surface-sunken font-mono text-xs select-text">
      {lines.map((line, index) => {
        const kind = classifyDiffLine(line);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff 行由文本派生、无稳定 id，整体重渲染
          <div key={index} className={cn("whitespace-pre px-2 leading-5", KIND_CLASS[kind])}>
            {line.length > 0 ? line : " "}
          </div>
        );
      })}
    </div>
  );
}
