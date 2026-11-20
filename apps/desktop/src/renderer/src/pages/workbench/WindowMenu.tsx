/**
 * 窗口标题栏的「⋯」菜单（§9 界面精简）：不是每次都用的操作收在这里，标题栏只留最大化和关闭。
 * 原来的会话栏（续接当前对话 / 开新对话 / 从历史续接 / 会话号）、管理者的自动压缩行、
 * 权限、上线下线、在后面加窗口都在这里。
 */

import type { WorkbenchPermissionLevel, WorkbenchWindow } from "@ff-pane/shared";
import {
  MAX_MANAGER_COMPACT_PERCENT,
  MIN_MANAGER_COMPACT_PERCENT,
  parseManagerCompactPercent,
  shortSessionId,
} from "@ff-pane/shared";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import {
  Copy,
  History,
  Info,
  MoreHorizontal,
  Plus,
  Radio,
  RotateCcw,
  Shield,
  SquarePen,
} from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";

export interface WindowMenuProps {
  readonly window: WorkbenchWindow;
  readonly isCli: boolean;
  readonly permission: WorkbenchPermissionLevel;
  /** 显示上线 / 下线（监管者、管理者）。 */
  readonly canGoOnline: boolean;
  readonly online: boolean;
  /** 显示自动压缩（管理者，Cursor 除外）。 */
  readonly showCompact: boolean;
  readonly onResumeCurrent: () => void;
  readonly onFresh: () => void;
  readonly onPickHistory: (sessionId: string) => void;
  readonly onEditPermission: () => void;
  readonly onToggleOnline: () => void;
  /** 勾上「不指定」= 用命令行自己的默认；去掉勾 = 用记下的比例。 */
  readonly onCompactUnspecified: (unspecified: boolean) => void;
  readonly onCompactPercent: (percent: number) => void;
  readonly onCompactCommit: () => void;
  readonly onAddWindow: () => void;
}

const ITEM =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs text-fg hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none";

export function WindowMenu(props: WindowMenuProps): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { window } = props;
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <Tooltip content={t("workbench.window.menu")}>
        <PopoverPrimitive.Trigger asChild>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("workbench.window.menu")}
            data-testid="workbench-window-menu"
          >
            <MoreHorizontal aria-hidden size={14} />
          </Button>
        </PopoverPrimitive.Trigger>
      </Tooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-50 flex w-60 flex-col gap-0.5 rounded-md border border-border bg-surface-raised p-1 shadow-raised"
          data-testid="workbench-window-menu-content"
          data-window-id={window.id}
        >
          {props.isCli ? (
            <>
              <button
                type="button"
                className={ITEM}
                data-testid="workbench-session-resume"
                onClick={run(props.onResumeCurrent)}
              >
                <RotateCcw aria-hidden size={13} />
                {t("workbench.session.resumeCurrent")}
              </button>
              <button
                type="button"
                className={ITEM}
                data-testid="workbench-session-fresh"
                onClick={run(props.onFresh)}
              >
                <SquarePen aria-hidden size={13} />
                {t("workbench.session.fresh")}
              </button>
              <label className={cn(ITEM, "cursor-default hover:bg-transparent")}>
                <History aria-hidden size={13} />
                <select
                  className="min-w-0 flex-1 rounded-sm border border-border bg-surface px-1 py-0.5 text-xs"
                  data-testid="workbench-session-history"
                  aria-label={t("workbench.session.pickHistory")}
                  value=""
                  onChange={(event) => {
                    const historyId = event.target.value;
                    if (historyId === "") {
                      return;
                    }
                    setOpen(false);
                    props.onPickHistory(historyId);
                  }}
                >
                  <option value="">{t("workbench.session.pickHistory")}</option>
                  {(window.conversations ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {shortSessionId(item.id)}
                    </option>
                  ))}
                </select>
              </label>
              {window.nativeSessionId !== undefined && window.sessionUnidentified !== true ? (
                <button
                  type="button"
                  className={ITEM}
                  data-testid="workbench-session-id"
                  title={window.nativeSessionId}
                  onClick={run(() => {
                    const id = window.nativeSessionId;
                    if (id !== undefined) {
                      void navigator.clipboard.writeText(id);
                    }
                  })}
                >
                  <Copy aria-hidden size={13} />
                  {t("workbench.session.copyId", { id: shortSessionId(window.nativeSessionId) })}
                </button>
              ) : null}
              <MenuSeparator />
              <button
                type="button"
                className={ITEM}
                data-testid="workbench-permission-badge"
                data-permission={props.permission}
                onClick={run(props.onEditPermission)}
              >
                <Shield
                  aria-hidden
                  size={13}
                  className={props.permission === "yolo" ? "text-danger-text" : undefined}
                />
                {t("workbench.permission.menuItem", {
                  level: t(`workbench.permission.level.${props.permission}`),
                })}
              </button>
              {props.canGoOnline ? (
                <Tooltip
                  content={t(
                    props.online ? "workbench.online.stopHint" : "workbench.online.startHint",
                  )}
                  side="left"
                >
                  <button
                    type="button"
                    className={ITEM}
                    data-testid="workbench-online-toggle"
                    data-online={props.online ? "yes" : "no"}
                    onClick={run(props.onToggleOnline)}
                  >
                    <Radio aria-hidden size={13} />
                    {t(props.online ? "workbench.online.stop" : "workbench.online.start")}
                  </button>
                </Tooltip>
              ) : null}
              {props.showCompact ? (
                <CompactControl
                  window={window}
                  onUnspecified={props.onCompactUnspecified}
                  onPercent={props.onCompactPercent}
                  onCommit={props.onCompactCommit}
                />
              ) : null}
              <MenuSeparator />
            </>
          ) : null}
          <button
            type="button"
            className={ITEM}
            aria-label={t("workbench.window.addWindow")}
            onClick={run(props.onAddWindow)}
          >
            <Plus aria-hidden size={13} />
            {t("workbench.window.addWindow")}
          </button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function MenuSeparator(): ReactElement {
  return <div className="my-0.5 h-px bg-border" />;
}

/** 管理者的自动压缩：原来单独一行，现在是菜单里的一项。三句说明放在 ⓘ 的提示里。 */
function CompactControl({
  window,
  onUnspecified,
  onPercent,
  onCommit,
}: {
  readonly window: WorkbenchWindow;
  readonly onUnspecified: (unspecified: boolean) => void;
  readonly onPercent: (percent: number) => void;
  readonly onCommit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const hint: ReactNode = (
    <span className="flex flex-col gap-0.5">
      <span>{t("workbench.window.compact.reopen")}</span>
      <span>{t("workbench.window.compact.notLater")}</span>
      <span>{t("workbench.window.compact.notStatus")}</span>
      {window.kind === "grok" ? <span>{t("workbench.window.compact.grokCap")}</span> : null}
    </span>
  );
  return (
    <div
      className="flex flex-col gap-1 px-2 py-1 text-xs"
      data-testid="workbench-compact-slider"
      data-compact={window.compactPercent ?? "default"}
    >
      <span className="flex items-center gap-1 text-fg">
        {t("workbench.window.compact.menuLabel")}
        {window.compactPercent !== undefined ? (
          <span className="text-fg" data-testid="workbench-compact-value">
            {t("workbench.window.compact.percent", { percent: window.compactPercent })}
          </span>
        ) : null}
        <Tooltip content={hint} side="left">
          <span
            className="ml-auto text-fg-muted"
            role="img"
            aria-label={t("workbench.window.compact.label")}
          >
            <Info aria-hidden size={12} />
          </span>
        </Tooltip>
      </span>
      <label className="flex items-center gap-1 text-2xs text-fg-muted">
        <input
          type="checkbox"
          data-testid="workbench-compact-unspecified"
          checked={window.compactPercent === undefined}
          onChange={(event) => {
            onUnspecified(event.target.checked);
          }}
        />
        {t("workbench.window.compact.unspecified")}
      </label>
      <input
        type="range"
        min={MIN_MANAGER_COMPACT_PERCENT}
        max={MAX_MANAGER_COMPACT_PERCENT}
        step={1}
        disabled={window.compactPercent === undefined}
        value={window.compactPercent ?? MIN_MANAGER_COMPACT_PERCENT}
        data-testid="workbench-compact-range"
        aria-label={t("workbench.window.compact.label")}
        onChange={(event) => {
          const parsed = parseManagerCompactPercent(Number(event.target.value));
          if (parsed !== undefined) {
            onPercent(parsed);
          }
        }}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
      />
    </div>
  );
}
