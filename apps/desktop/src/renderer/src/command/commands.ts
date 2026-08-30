/**
 * 命令表（W3.1c）—— 命令面板里可执行的条目，分三组：导航 / 操作 / 设置。
 *
 * 与快捷键表的关系：
 * - 快捷键表（shortcuts.ts）是"键位 → 命令"的映射，19 条，含只在键盘上有意义的
 *   条目（Esc、↑/↓、Enter、Ctrl+1~7）；
 * - 命令表是"面板里可以点的事"，把 Ctrl+1~7 摊成七个具名导航命令，
 *   并把纯键盘操作（Esc / 列表移动）排除在外——它们仍然能在面板的
 *   「快捷键」视图里搜到并显示键位（设计系统 §6.4 的可发现性要求由该视图兜底）。
 *
 * 导航如何执行：命令表只声明目标页面，实际跳转由挂载时注入的 navigate 回调完成。
 * 本目录**不 import router**，因此 W3.1b 的路由实现与本模块完全解耦。
 *
 * 动作如何执行：requiresHandler 为 true 的命令等页面工单注入 handler；
 * 未注入时面板把它显示为「待接入」（disabled + 一行说明），既可被搜到、
 * 又不会点了没反应。
 */
import { type PageKey, shortcutIndexOfPage } from "../stores/pages";
import type { CommandId } from "./ids";
import { formatShortcutSpec, type ShortcutRegistry } from "./shortcuts";

export const COMMAND_GROUPS = ["navigation", "action", "settings"] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/** 导航目标：页面切换或历史前进后退，语义由集成方的 navigate 回调落实。 */
export type NavigationTarget =
  | { readonly kind: "page"; readonly page: PageKey }
  | { readonly kind: "history"; readonly direction: "back" | "forward" };

export interface CommandDescriptor {
  readonly id: CommandId;
  readonly group: CommandGroup;
  /** 导航类命令的目标（有此字段即为导航类，执行时不需要 handler）。 */
  readonly navigation?: NavigationTarget;
  /** 是否必须由页面工单注入 handler 才能执行。 */
  readonly requiresHandler: boolean;
}

function pageCommand(id: CommandId, page: PageKey): CommandDescriptor {
  return { id, group: "navigation", navigation: { kind: "page", page }, requiresHandler: false };
}

export const COMMAND_TABLE: readonly CommandDescriptor[] = [
  // 导航组：七个页面 + 前进后退 + 切换项目
  pageCommand("nav-projects", "projects"),
  pageCommand("nav-session", "session"),
  pageCommand("nav-plan", "plan"),
  pageCommand("nav-tasks", "tasks"),
  pageCommand("nav-runs", "runs"),
  pageCommand("nav-memory", "memory"),
  pageCommand("nav-knowledge", "knowledge"),
  {
    id: "nav-back",
    group: "navigation",
    navigation: { kind: "history", direction: "back" },
    requiresHandler: false,
  },
  {
    id: "nav-forward",
    group: "navigation",
    navigation: { kind: "history", direction: "forward" },
    requiresHandler: false,
  },
  // 面板自身的模式切换（项目模式，§7 的 Ctrl+P）
  { id: "palette-projects", group: "navigation", requiresHandler: false },

  // 操作组：全部由对应页面工单注入 handler
  { id: "page-focus-search", group: "action", requiresHandler: true },
  { id: "session-send", group: "action", requiresHandler: true },
  { id: "session-insert-knowledge", group: "action", requiresHandler: true },
  { id: "session-switch-role", group: "action", requiresHandler: true },
  { id: "tasks-dispatch", group: "action", requiresHandler: true },
  { id: "tasks-accept", group: "action", requiresHandler: true },
  { id: "memory-approve", group: "action", requiresHandler: true },
  { id: "memory-reject", group: "action", requiresHandler: true },

  // 设置组
  {
    id: "settings-open",
    group: "settings",
    navigation: { kind: "page", page: "settings" },
    requiresHandler: false,
  },
  { id: "help-shortcuts", group: "settings", requiresHandler: false },
];

export const COMMAND_BY_ID: ReadonlyMap<CommandId, CommandDescriptor> = new Map(
  COMMAND_TABLE.map((command) => [command.id, command]),
);

export function commandsInGroup(group: CommandGroup): readonly CommandDescriptor[] {
  return COMMAND_TABLE.filter((command) => command.group === group);
}

/**
 * 命令在面板里展示的键位。
 * 七个页面导航命令自身没有独立登记，键位来自 §7 的 Ctrl+1~7（按页面序号推导），
 * 这样面板里每个页面条目都能显示自己的键位。
 */
export function commandShortcutDisplay(
  registry: ShortcutRegistry,
  id: CommandId,
): string | undefined {
  const direct = registry.displayFor(id);
  if (direct !== undefined) {
    return direct;
  }
  const navigation = COMMAND_BY_ID.get(id)?.navigation;
  if (navigation?.kind !== "page" || registry.byCommandId("nav-page-by-index") === undefined) {
    return undefined;
  }
  const index = shortcutIndexOfPage(navigation.page);
  return index === undefined ? undefined : formatShortcutSpec(`Ctrl+${index}`);
}
