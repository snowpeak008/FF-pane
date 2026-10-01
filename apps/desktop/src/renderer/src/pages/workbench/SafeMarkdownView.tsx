/**
 * 把安全 Markdown 块渲染成文本节点。不使用 HTML 注入。
 */

import type { ReactElement } from "react";
import { parseSafeMarkdown } from "../../../../shared/workbench/safe-markdown";

export function SafeMarkdownView({ source }: { readonly source: string }): ReactElement {
  const blocks = parseSafeMarkdown(source);
  return (
    <div className="space-y-2 text-sm text-fg" data-testid="workbench-brief-preview">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === "heading") {
          const className =
            block.level === 1 ? "text-base font-medium" : "text-sm font-medium text-fg";
          return (
            <p key={key} className={className}>
              {block.text}
            </p>
          );
        }
        if (block.type === "code") {
          return (
            <pre
              key={key}
              className="overflow-auto rounded-sm bg-surface-sunken p-2 font-mono text-xs text-fg"
            >
              {block.text}
            </pre>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={key} className="list-disc space-y-1 pl-4">
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "quote") {
          return (
            <blockquote
              key={key}
              className="whitespace-pre-wrap border-l-2 border-border pl-2 text-fg-muted"
            >
              {block.text}
            </blockquote>
          );
        }
        return (
          <p key={key} className="whitespace-pre-wrap">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}
