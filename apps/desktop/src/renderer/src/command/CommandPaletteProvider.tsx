/**
 * CommandPaletteProvider（W3.1c）—— 自足挂载入口：全局快捷键 + 命令面板 + 作用域登记。
 *
 * 挂载方式见 command/index.ts 的头注（集成说明）。
 * 一个应用只挂一个实例，位置在 ThemeProvider 之内、布局骨架之外或之内均可
 * （它只渲染 children + 一个 portal 浮层，不影响布局）。
 */
import { type ReactElement, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { CommandPalette, type PaletteProjectItem } from "./CommandPalette";
import type { NavigationTarget } from "./commands";
import { CommandPaletteContext, type CommandPaletteContextValue } from "./context";
import {
  type CommandHandlerMap,
  type CommandRuntime,
  executeCommand,
  isCommandRunnable,
  type PaletteMode,
  paletteModeOf,
} from "./execute";
import { mergeHandlers, withHandler, withoutHandler } from "./handler-registry";
import type { CommandId } from "./ids";
import { createShortcutRegistry, SHORTCUT_TABLE, type ShortcutScope } from "./shortcuts";
import { useGlobalShortcuts } from "./useGlobalShortcuts";

export interface CommandPaletteProviderProps {
  readonly children: ReactNode;
  /**
   * 导航回调（必填）：集成方在 T3.1 接 W3.1b 的路由实现。
   * 本目录不 import router —— 命令面板与路由方案完全解耦。
   */
  readonly navigate: (target: NavigationTarget) => void;
  /** 页面工单注入的动作表；未注入的命令在面板里显示为「待接入」。 */
  readonly handlers?: CommandHandlerMap | undefined;
  /** 项目模式（Ctrl+P）的候选项；本工单不新增 IPC 通道，数据由挂载方给。 */
  readonly projects?: readonly PaletteProjectItem[] | undefined;
  /** 选中项目后的回调。 */
  readonly onSelectProject?: ((projectId: string) => void) | undefined;
}

const EMPTY_HANDLERS: CommandHandlerMap = {};
const EMPTY_PROJECTS: readonly PaletteProjectItem[] = [];

export function CommandPaletteProvider({
  children,
  navigate,
  handlers = EMPTY_HANDLERS,
  projects = EMPTY_PROJECTS,
  onSelectProject,
}: CommandPaletteProviderProps): ReactElement {
  const registry = useMemo(() => createShortcutRegistry(SHORTCUT_TABLE), []);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PaletteMode>("commands");
  // 同一作用域可能被多个组件同时声明（如页面 + 页内列表），计数到 0 才真正失效
  const scopeCounts = useRef<Map<ShortcutScope, number>>(new Map());
  const [activeScopes, setActiveScopes] = useState<readonly ShortcutScope[]>([]);
  // 页面在挂载时报上来的动作（registerCommand）。与 handlers prop 合并，prop 优先——
  // 挂载方是集成方，它显式给的动作不该被某个页面悄悄顶掉。
  const [pageHandlers, setPageHandlers] = useState<CommandHandlerMap>(EMPTY_HANDLERS);

  const openPalette = useCallback((next: PaletteMode = "commands") => {
    setMode(next);
    setOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
  }, []);

  const activateScope = useCallback((scope: ShortcutScope) => {
    const counts = scopeCounts.current;
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
    setActiveScopes([...counts.keys()]);
    return () => {
      const remaining = (counts.get(scope) ?? 0) - 1;
      if (remaining > 0) {
        counts.set(scope, remaining);
      } else {
        counts.delete(scope);
      }
      setActiveScopes([...counts.keys()]);
    };
  }, []);

  const registerCommand = useCallback((commandId: CommandId, handler: () => void) => {
    setPageHandlers((previous) => withHandler(previous, commandId, handler));
    return () => {
      setPageHandlers((previous) => withoutHandler(previous, commandId, handler));
    };
  }, []);

  const mergedHandlers = useMemo<CommandHandlerMap>(
    () => mergeHandlers(pageHandlers, handlers),
    [pageHandlers, handlers],
  );

  const runtime = useMemo<CommandRuntime>(
    () => ({ navigate, handlers: mergedHandlers, openPalette, closePalette }),
    [navigate, mergedHandlers, openPalette, closePalette],
  );

  const runCommand = useCallback(
    (commandId: CommandId, matchedKey?: string): boolean => {
      const handled = executeCommand(commandId, runtime, matchedKey);
      // 切换面板模式的命令不关面板；其余命令执行后收起面板
      if (handled && paletteModeOf(commandId) === undefined) {
        setOpen(false);
      }
      return handled;
    },
    [runtime],
  );

  const isRunnable = useCallback(
    (commandId: CommandId) => isCommandRunnable(commandId, mergedHandlers),
    [mergedHandlers],
  );

  const handleSelectProject = useCallback(
    (projectId: string) => {
      onSelectProject?.(projectId);
      setOpen(false);
    },
    [onSelectProject],
  );

  useGlobalShortcuts({ registry, activeScopes, execute: runCommand });

  const value = useMemo<CommandPaletteContextValue>(
    () => ({
      open,
      mode,
      openPalette,
      closePalette,
      runCommand,
      isRunnable,
      activateScope,
      activeScopes,
      registerCommand,
      shortcutRegistry: registry,
      handlers: mergedHandlers,
    }),
    [
      open,
      mode,
      openPalette,
      closePalette,
      runCommand,
      isRunnable,
      activateScope,
      activeScopes,
      registerCommand,
      registry,
      mergedHandlers,
    ],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette
        open={open}
        mode={mode}
        registry={registry}
        handlers={mergedHandlers}
        projects={projects}
        onOpenChange={setOpen}
        onRunCommand={runCommand}
        onSelectProject={handleSelectProject}
      />
    </CommandPaletteContext.Provider>
  );
}
