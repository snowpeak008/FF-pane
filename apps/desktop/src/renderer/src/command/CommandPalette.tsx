/**
 * 命令面板（W3.1c）—— cmdk 实现，Ctrl+K 唤起，样式严格取自设计系统 token。
 *
 * 三个模式（§7 的三个全局键位各自对应一个）：
 *   commands   Ctrl+K  命令：导航 / 操作 / 设置 三组
 *   projects   Ctrl+P  项目：项目列表由挂载方注入（本工单不新增 IPC 通道）
 *   shortcuts  Ctrl+/  快捷键帮助：19 条全表，按作用域分组，逐条显示键位
 *              —— 设计系统 §6.4「所有快捷键必须能在命令面板里搜到并显示键位」由此视图兜底
 *
 * 搜索：关掉 cmdk 内置过滤（command-score 对中文几乎不打分），
 * 改用 search.ts 的纯函数过滤，中英文与键位串均可命中。
 */
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { COMMAND_TABLE, commandShortcutDisplay } from "./commands";
import {
  type CommandHandlerMap,
  isCommandRunnable,
  type PaletteMode,
  paletteModeOf,
} from "./execute";
import { type CommandId, commandKeywordsKey, commandTitleKey, shortcutActionKey } from "./ids";
import { filterBySearch, type SearchableFields } from "./search";
import type { ShortcutRegistry } from "./shortcuts";

/** 项目模式的条目：由挂载方（项目列表页工单/集成方）注入，面板自己不查数据。 */
export interface PaletteProjectItem {
  readonly id: string;
  readonly name: string;
  /** 项目路径（参与搜索，并作为副标题显示）。 */
  readonly path: string;
}

interface PaletteEntry extends SearchableFields {
  /** 分组标题（已翻译）。 */
  readonly group: string;
  /** 副标题/说明（待接入提示、项目路径）。 */
  readonly hint?: string | undefined;
  readonly runnable: boolean;
  readonly select: () => void;
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly mode: PaletteMode;
  readonly registry: ShortcutRegistry;
  readonly handlers: CommandHandlerMap;
  readonly projects: readonly PaletteProjectItem[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onRunCommand: (commandId: CommandId) => void;
  readonly onSelectProject: (projectId: string) => void;
}

const ITEM_CLASS = cn(
  "flex h-8 cursor-pointer items-center justify-between gap-3 rounded-sm px-2 text-sm text-fg",
  "transition-colors duration-100 data-[selected=true]:bg-surface-active",
  "data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-55",
);

const GROUP_CLASS = cn(
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1",
  "[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium",
  "[&_[cmdk-group-heading]]:text-fg-muted",
);

const MODE_HINT_COMMANDS: readonly CommandId[] = [
  "palette-open",
  "palette-projects",
  "help-shortcuts",
];

export function CommandPalette({
  open,
  mode,
  registry,
  handlers,
  projects,
  onOpenChange,
  onRunCommand,
  onSelectProject,
}: CommandPaletteProps): ReactElement {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [value, setValue] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: 模式切换等同于重新打开面板，同样要清空搜索词
  useEffect(() => {
    setSearch("");
  }, [open, mode]);

  const entries = useMemo<readonly PaletteEntry[]>(() => {
    if (mode === "projects") {
      const group = t("command.mode.projects");
      return projects.map((project) => ({
        id: `project:${project.id}`,
        title: project.name,
        keywords: project.path,
        group,
        hint: project.path,
        runnable: true,
        select: () => {
          onSelectProject(project.id);
        },
      }));
    }
    if (mode === "shortcuts") {
      return registry.entries().map((registration) => {
        const { commandId } = registration;
        const display = registry.displayFor(commandId);
        const scopes = registration.scopes.map((scope) => t(`shortcut.scope.${scope}`)).join(" / ");
        const runnable = isCommandRunnable(commandId, handlers);
        return {
          id: `shortcut:${commandId}`,
          title: t(shortcutActionKey(commandId)),
          keywords: `${display ?? ""} ${scopes} ${commandId} ${t(commandKeywordsKey(commandId))}`,
          shortcut: display,
          group: scopes,
          hint: runnable ? undefined : t("command.palette.pending"),
          runnable,
          select: () => {
            onRunCommand(commandId);
          },
        };
      });
    }
    return COMMAND_TABLE.map((command) => {
      const runnable = isCommandRunnable(command.id, handlers);
      return {
        id: `command:${command.id}`,
        title: t(commandTitleKey(command.id)),
        keywords: t(commandKeywordsKey(command.id)),
        shortcut: commandShortcutDisplay(registry, command.id),
        group: t(`command.group.${command.group}`),
        hint: runnable ? undefined : t("command.palette.pending"),
        runnable,
        select: () => {
          onRunCommand(command.id);
        },
      };
    });
  }, [mode, projects, registry, handlers, t, onRunCommand, onSelectProject]);

  const groups = useMemo(() => {
    const ordered: { label: string; items: PaletteEntry[] }[] = [];
    for (const entry of filterBySearch(entries, search)) {
      const bucket = ordered.find((group) => group.label === entry.group);
      if (bucket === undefined) {
        ordered.push({ label: entry.group, items: [entry] });
      } else {
        bucket.items.push(entry);
      }
    }
    return ordered;
  }, [entries, search]);

  const firstId = groups[0]?.items[0]?.id ?? "";
  useEffect(() => {
    setValue(firstId);
  }, [firstId]);

  const isEmpty = groups.length === 0;
  const emptyMessage =
    mode === "projects" && projects.length === 0
      ? t("command.projects.empty")
      : t("command.palette.empty");

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={t("command.palette.label")}
      shouldFilter={false}
      value={value}
      onValueChange={setValue}
      loop
      overlayClassName="fixed inset-0 z-40 bg-overlay"
      contentClassName={cn(
        "fixed left-1/2 top-24 z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden",
        "rounded-lg border border-border bg-surface-raised shadow-overlay",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
        {/* outline-none 的等效可见样式：面板打开即聚焦此输入框，焦点位置无歧义（设计系统 §6.4） */}
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder={t("command.palette.placeholder")}
          className="h-9 w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
        />
      </div>

      <Command.List className="max-h-80 overflow-y-auto p-1">
        {isEmpty ? (
          <div className="px-2 py-3 text-sm text-fg-muted">{emptyMessage}</div>
        ) : (
          groups.map((group) => (
            <Command.Group key={group.label} heading={group.label} className={GROUP_CLASS}>
              {group.items.map((entry) => (
                <Command.Item
                  key={entry.id}
                  value={entry.id}
                  disabled={!entry.runnable}
                  onSelect={entry.select}
                  className={ITEM_CLASS}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate">{entry.title}</span>
                    {entry.hint === undefined ? null : (
                      <span className="shrink-0 truncate font-mono text-2xs text-fg-subtle">
                        {entry.hint}
                      </span>
                    )}
                  </span>
                  {entry.shortcut === undefined ? null : (
                    <kbd className="shrink-0 font-mono text-2xs text-fg-subtle">
                      {entry.shortcut}
                    </kbd>
                  )}
                </Command.Item>
              ))}
            </Command.Group>
          ))
        )}
      </Command.List>

      <div className="flex h-7 items-center gap-3 border-t border-border px-3 text-2xs text-fg-subtle">
        {MODE_HINT_COMMANDS.map((commandId) => {
          const hintMode = paletteModeOf(commandId);
          const display = registry.displayFor(commandId);
          if (hintMode === undefined || display === undefined) {
            return null;
          }
          return (
            <span key={commandId} className="flex items-center gap-1">
              <kbd className="font-mono">{display}</kbd>
              <span className={cn(hintMode === mode && "text-fg-muted")}>
                {t(`command.mode.${hintMode}`)}
              </span>
            </span>
          );
        })}
      </div>
    </Command.Dialog>
  );
}
