/**
 * 命令 ID 词表（W3.1c）—— 快捷键表、命令面板、执行器三处共用同一套标识符。
 *
 * 为什么单独一个零依赖文件：shortcuts.ts 与 commands.ts 互为上下游，
 * 把 ID 抽出来两边都 import 它，避免循环依赖。
 *
 * 命名：<域>-<动作>，全小写 kebab-case。语言包键由 ID 直接派生：
 *   命令标题     command.item.<id>.title
 *   搜索关键词   command.item.<id>.keywords
 *   快捷键作用   shortcut.action.<id>
 * 新增 ID 必须同时补两个语言包（locales-parity 单测会拦缺失）。
 */

export const COMMAND_IDS = [
  // 面板与全局
  "palette-open",
  "palette-projects",
  "help-shortcuts",
  "settings-open",
  "app-dismiss",
  // 导航
  "nav-back",
  "nav-forward",
  "nav-page-by-index",
  "nav-projects",
  "nav-session",
  "nav-plan",
  "nav-tasks",
  "nav-runs",
  "nav-memory",
  "nav-knowledge",
  // 页面与列表通用
  "page-focus-search",
  "list-move-up",
  "list-move-down",
  "list-open",
  // 会话页
  "session-send",
  "session-insert-knowledge",
  "session-switch-role",
  // 任务页
  "tasks-dispatch",
  "tasks-accept",
  // 记忆审核
  "memory-approve",
  "memory-reject",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

const COMMAND_ID_SET: ReadonlySet<string> = new Set(COMMAND_IDS);

export function isCommandId(value: string): value is CommandId {
  return COMMAND_ID_SET.has(value);
}

/** 命令标题的语言包键。 */
export function commandTitleKey(id: CommandId): string {
  return `command.item.${id}.title`;
}

/** 命令搜索关键词的语言包键（两语言包里都同时含中英词，保证跨语言可搜）。 */
export function commandKeywordsKey(id: CommandId): string {
  return `command.item.${id}.keywords`;
}

/** 快捷键"作用"描述的语言包键（设计系统 §7 表格第二列）。 */
export function shortcutActionKey(id: CommandId): string {
  return `shortcut.action.${id}`;
}
