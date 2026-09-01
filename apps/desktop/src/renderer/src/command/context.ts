/**
 * 命令面板上下文（W3.1c）：页面/组件通过它打开面板、执行命令、声明快捷键作用域。
 * 面板的开合状态刻意不进 ui store —— 浮层开合归浮层自己，避免 stores 与 command 互相依赖。
 */
import { createContext } from "react";
import type { CommandHandlerMap, PaletteMode } from "./execute";
import type { CommandId } from "./ids";
import type { ShortcutRegistry, ShortcutScope } from "./shortcuts";

export interface CommandPaletteContextValue {
  readonly open: boolean;
  readonly mode: PaletteMode;
  /** 打开面板；不传模式则用命令模式。 */
  readonly openPalette: (mode?: PaletteMode) => void;
  readonly closePalette: () => void;
  /** 执行命令（与快捷键同一条路径）；返回是否真的执行了。 */
  readonly runCommand: (commandId: CommandId) => boolean;
  /** 该命令当前是否可执行（未注入 handler 的动作为 false）。 */
  readonly isRunnable: (commandId: CommandId) => boolean;
  /** 声明一个激活作用域，返回撤销函数（页面请用 useShortcutScope 包装）。 */
  readonly activateScope: (scope: ShortcutScope) => () => void;
  readonly activeScopes: readonly ShortcutScope[];
  /**
   * 注册一个命令动作，返回注销函数（页面请用 useCommandHandler 包装）。
   *
   * 与 Provider 的 `handlers` prop 是两条互补的路（T8.1 补入后者之外的这一条）：
   * prop 适合挂载方就知道怎么做的动作；而像「从知识库插入」这种动作要开的对话框
   * 状态就住在页面组件内部，挂载方拿不到，只能由页面自己在挂载时报上来。
   */
  readonly registerCommand: (commandId: CommandId, handler: () => void) => () => void;
  readonly shortcutRegistry: ShortcutRegistry;
  readonly handlers: CommandHandlerMap;
}

export const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);
