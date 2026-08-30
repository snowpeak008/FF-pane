/**
 * 命令执行器（W3.1c）—— 快捷键与命令面板走同一条执行路径，纯函数，可单测。
 *
 * 依赖全部经 CommandRuntime 注入：
 * - navigate：集成方（T3.1）接 W3.1b 的路由，本目录不 import router；
 * - handlers：页面工单注入自己的动作，未注入的命令执行时返回 false（面板显示为待接入）；
 * - openPalette / closePalette：面板自身的开合。
 *
 * 返回值语义：true = 已执行；false = 无处可执行（键位不吃事件、面板不关闭）。
 */
import { pageKeyByShortcutIndex } from "../stores/pages";
import { COMMAND_BY_ID, type NavigationTarget } from "./commands";
import type { CommandId } from "./ids";

/** 面板的三种模式：命令 / 项目（Ctrl+P）/ 快捷键帮助（Ctrl+/）。 */
export type PaletteMode = "commands" | "projects" | "shortcuts";

/** 页面工单注入的动作表；键是命令 ID，缺省即"未接入"。 */
export type CommandHandlerMap = Partial<Record<CommandId, () => void>>;

export interface CommandRuntime {
  readonly navigate: (target: NavigationTarget) => void;
  readonly handlers: CommandHandlerMap;
  readonly openPalette: (mode: PaletteMode) => void;
  readonly closePalette: () => void;
}

/** 打开/切换面板模式的命令：从面板里执行它们不应顺手把面板关掉。 */
const PALETTE_MODE_BY_COMMAND: Partial<Record<CommandId, PaletteMode>> = {
  "palette-open": "commands",
  "palette-projects": "projects",
  "help-shortcuts": "shortcuts",
};

export function paletteModeOf(id: CommandId): PaletteMode | undefined {
  return PALETTE_MODE_BY_COMMAND[id];
}

/** 命令当前是否可执行（面板据此把未接入的命令渲染为 disabled + 说明）。 */
export function isCommandRunnable(id: CommandId, handlers: CommandHandlerMap): boolean {
  if (PALETTE_MODE_BY_COMMAND[id] !== undefined) {
    return true;
  }
  if (id === "app-dismiss" || id === "nav-page-by-index") {
    return true;
  }
  if (COMMAND_BY_ID.get(id)?.navigation !== undefined) {
    return true;
  }
  return handlers[id] !== undefined;
}

/**
 * 执行一个命令。
 * @param matchedKey 命中的规范化主键（如 Ctrl+3 的 "3"），仅 nav-page-by-index 需要
 */
export function executeCommand(
  id: CommandId,
  runtime: CommandRuntime,
  matchedKey?: string,
): boolean {
  const paletteMode = PALETTE_MODE_BY_COMMAND[id];
  if (paletteMode !== undefined) {
    runtime.openPalette(paletteMode);
    return true;
  }
  if (id === "app-dismiss") {
    // 最上层浮层的关闭归 radix / 页面各自处理；全局层只负责收掉命令面板
    runtime.closePalette();
    return true;
  }
  if (id === "nav-page-by-index") {
    const page = matchedKey === undefined ? undefined : pageKeyByShortcutIndex(Number(matchedKey));
    if (page === undefined) {
      return false;
    }
    runtime.navigate({ kind: "page", page });
    return true;
  }
  const navigation = COMMAND_BY_ID.get(id)?.navigation;
  if (navigation !== undefined) {
    runtime.navigate(navigation);
    return true;
  }
  const handler = runtime.handlers[id];
  if (handler === undefined) {
    return false;
  }
  handler();
  return true;
}
