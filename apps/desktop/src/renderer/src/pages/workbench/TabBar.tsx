/**
 * 工作台标签栏（T10.2）：新建 / 切换 / 关闭 / 双击重命名。
 */

import type { WorkbenchTab } from "@ff-pane/shared";
import { Plus, X } from "lucide-react";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";

export interface TabBarProps {
  readonly tabs: readonly WorkbenchTab[];
  readonly activeTabId: string | null;
  readonly onSelect: (tabId: string) => void;
  readonly onClose: (tabId: string) => void;
  readonly onRename: (tabId: string, title: string) => void;
  readonly onNewTab: () => void;
}

export function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onRename,
  onNewTab,
}: TabBarProps): ReactElement {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-surface px-1"
      data-testid="workbench-tab-bar"
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          if (editingId === tab.id) {
            return (
              <input
                key={tab.id}
                className="h-6 w-28 rounded-sm border border-border-strong bg-surface px-1 text-xs"
                value={draft}
                ref={(el) => {
                  el?.focus();
                }}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => {
                  setEditingId(null);
                  onRename(tab.id, draft);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setEditingId(null);
                    onRename(tab.id, draft);
                  }
                  if (event.key === "Escape") {
                    setEditingId(null);
                  }
                }}
              />
            );
          }
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex h-6 max-w-40 items-center gap-1 rounded-sm border px-1.5",
                active
                  ? "border-border bg-surface-active text-fg"
                  : "border-transparent text-fg-muted hover:bg-surface-hover",
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-xs"
                data-testid="workbench-tab"
                data-tab-id={tab.id}
                onClick={() => onSelect(tab.id)}
                onDoubleClick={() => {
                  setDraft(tab.title);
                  setEditingId(tab.id);
                }}
              >
                {tab.title}
              </button>
              <button
                type="button"
                className="rounded-sm p-0.5 opacity-0 hover:bg-surface-active group-hover:opacity-100"
                aria-label={t("workbench.tab.close")}
                onClick={() => onClose(tab.id)}
              >
                <X aria-hidden size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={t("workbench.tab.new")}
        data-testid="workbench-new-tab"
        onClick={onNewTab}
      >
        <Plus aria-hidden size={14} />
      </Button>
    </div>
  );
}
