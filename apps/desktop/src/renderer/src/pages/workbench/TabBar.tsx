/**
 * 工作台标签栏（T10.2）：新建 / 切换 / 关闭 / 双击重命名。
 * 48px 高、标签固定 160px 宽（T11.2a）；选中的标签和下面的工作区连成一片，切换时滚到看得见。
 * 拖窗口时（T11.2c）标签和「＋」都是落点：加到那一页末尾，或开新页。
 * 「在这页加窗口」（T11.2d）：加到当前页末尾，满了开新页。
 */

import type { WorkbenchTab } from "@ff-pane/shared";
import { Plus, SquarePlus, X } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WindowDropTarget } from "../../../../shared/workbench/grid";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";

export interface TabBarProps {
  readonly tabs: readonly WorkbenchTab[];
  readonly activeTabId: string | null;
  readonly onSelect: (tabId: string) => void;
  readonly onClose: (tabId: string) => void;
  readonly onRename: (tabId: string, title: string) => void;
  readonly onNewTab: () => void;
  /** 在当前页加一个窗口；没有当前页时不显示。 */
  readonly onAddToPage?: (() => void) | undefined;
  /** 正在拖窗口时指针下的落点。 */
  readonly dropTarget?: WindowDropTarget | null;
}

export function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onRename,
  onNewTab,
  onAddToPage,
  dropTarget = null,
}: TabBarProps): ReactElement {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const activeRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换标签、增删标签后都要把选中的那个滚进视野
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  return (
    <div
      className="flex h-12 shrink-0 items-stretch gap-1 border-b border-border bg-surface px-1"
      data-testid="workbench-tab-bar"
    >
      <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto overflow-y-hidden pt-1.5">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          if (editingId === tab.id) {
            return (
              <input
                key={tab.id}
                className="my-1.5 w-40 shrink-0 rounded-sm border border-border-strong bg-surface px-2 text-sm"
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
              ref={active ? activeRef : undefined}
              title={tab.title}
              data-drop="tab"
              data-tab-id={tab.id}
              className={cn(
                "group flex w-40 shrink-0 items-center gap-1 rounded-t-md border-x border-t-2 px-3",
                active
                  ? "border-x-border border-t-primary bg-canvas text-fg"
                  : "border-x-border border-t-border bg-surface-sunken text-fg-muted hover:bg-surface-hover",
                dropTarget?.kind === "tab" &&
                  dropTarget.tabId === tab.id &&
                  "bg-primary-surface ring-2 ring-primary ring-inset",
              )}
            >
              <button
                type="button"
                className="h-full min-w-0 flex-1 truncate text-left text-sm"
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
                className={cn(
                  "rounded-sm p-1 hover:bg-surface-active",
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
                aria-label={t("workbench.tab.close")}
                onClick={() => onClose(tab.id)}
              >
                <X aria-hidden size={14} />
              </button>
            </div>
          );
        })}
      </div>
      {onAddToPage !== undefined ? (
        <Button
          variant="ghost"
          size="md"
          iconOnly
          aria-label={t("workbench.tab.addWindow")}
          title={t("workbench.tab.addWindow")}
          data-testid="workbench-add-window"
          className="self-center"
          onClick={onAddToPage}
        >
          <SquarePlus aria-hidden size={18} />
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="md"
        iconOnly
        aria-label={t("workbench.tab.new")}
        title={t("workbench.tab.new")}
        data-testid="workbench-new-tab"
        data-drop="new-tab"
        className={cn(
          "self-center",
          dropTarget?.kind === "new-tab" && "bg-primary-surface ring-2 ring-primary",
        )}
        onClick={onNewTab}
      >
        <Plus aria-hidden size={18} />
      </Button>
    </div>
  );
}
