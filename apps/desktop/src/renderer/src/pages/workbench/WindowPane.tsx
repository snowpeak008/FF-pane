/**
 * 工作台窗口壳：标题栏 + 状态 + 操作 + TerminalView（T10.2）。
 * 非活动标签 / 非当前项目不挂载本组件（由父级决定），以卸载 xterm。
 */

import type { WorkbenchWindow } from "@ff-pane/shared";
import { Columns2, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { TerminalView } from "./TerminalView";

export interface WindowPaneProps {
  readonly window: WorkbenchWindow;
  readonly projectRoot: string;
  readonly focused: boolean;
  readonly maximized: boolean;
  readonly onFocus: () => void;
  readonly onClose: () => void;
  readonly onSplitRight: () => void;
  readonly onSplitDown: () => void;
  readonly onToggleMaximize: () => void;
  readonly onRename: (title: string) => void;
  readonly onTerminalIdChange: (terminalId: string | undefined) => void;
  readonly onCwdFallback: () => void;
}

export function WindowPane({
  window,
  projectRoot,
  focused,
  maximized,
  onFocus,
  onClose,
  onSplitRight,
  onSplitDown,
  onToggleMaximize,
  onRename,
  onTerminalIdChange,
  onCwdFallback,
}: WindowPaneProps): ReactElement {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(window.title);
  const [exitCode, setExitCode] = useState<number | undefined>(undefined);
  const running = exitCode === undefined && window.terminalId !== undefined;

  return (
    // 整窗点击聚焦：非按钮语义，故意用容器监听
    // biome-ignore lint/a11y/noStaticElementInteractions: pane focus-on-click
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border bg-surface",
        focused ? "border-primary" : "border-border",
      )}
      data-testid="workbench-window"
      data-window-id={window.id}
      onMouseDown={onFocus}
    >
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border bg-surface-sunken px-1">
        {editing ? (
          <input
            className="min-w-0 flex-1 rounded-sm border border-border-strong bg-surface px-1 text-xs text-fg"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            ref={(el) => {
              el?.focus();
            }}
            onBlur={() => {
              setEditing(false);
              onRename(draft);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                setEditing(false);
                onRename(draft);
              }
              if (event.key === "Escape") {
                setDraft(window.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate px-1 text-left text-xs font-medium text-fg"
            onDoubleClick={() => {
              setDraft(window.title);
              setEditing(true);
            }}
          >
            {window.title}
          </button>
        )}
        {/* 预留：role / permission / parent 标识位（T10.5），本单不显示假数据 */}
        <span
          className={cn(
            "shrink-0 rounded-sm px-1 text-2xs",
            exitCode !== undefined
              ? "bg-danger-surface text-danger-text"
              : running
                ? "bg-success-surface text-success-text"
                : "bg-surface-active text-fg-muted",
          )}
          data-testid="workbench-window-status"
        >
          {exitCode !== undefined
            ? t("workbench.window.status.exited")
            : running
              ? t("workbench.window.status.running")
              : t("workbench.window.status.starting")}
        </span>
        <Tooltip content={t("workbench.window.splitRight")}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("workbench.window.splitRight")}
            onClick={onSplitRight}
          >
            <Columns2 aria-hidden size={14} />
          </Button>
        </Tooltip>
        <Tooltip content={t("workbench.window.splitDown")}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("workbench.window.splitDown")}
            onClick={onSplitDown}
          >
            <Rows2 aria-hidden size={14} />
          </Button>
        </Tooltip>
        <Tooltip
          content={maximized ? t("workbench.window.restore") : t("workbench.window.maximize")}
        >
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={maximized ? t("workbench.window.restore") : t("workbench.window.maximize")}
            onClick={onToggleMaximize}
          >
            {maximized ? <Minimize2 aria-hidden size={14} /> : <Maximize2 aria-hidden size={14} />}
          </Button>
        </Tooltip>
        <Tooltip content={t("workbench.window.close")}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("workbench.window.close")}
            onClick={onClose}
          >
            <X aria-hidden size={14} />
          </Button>
        </Tooltip>
      </div>
      <TerminalView
        windowId={window.id}
        projectId={window.projectId}
        cwd={window.cwd}
        fallbackCwd={projectRoot}
        onTerminalIdChange={onTerminalIdChange}
        onExitCodeChange={setExitCode}
        onCwdFallback={onCwdFallback}
      />
    </section>
  );
}
