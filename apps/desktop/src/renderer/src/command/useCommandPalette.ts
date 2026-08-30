/**
 * 命令面板与快捷键作用域的消费 hook（W3.1c）。
 *
 * 页面工单用法：
 *   const { openPalette } = useCommandPalette();     // 工具栏按钮打开面板
 *   useShortcutScope("session");                     // 本页面激活「会话页」作用域
 *   useShortcutScope("list", listHasFocus);          // 列表获得焦点时才激活列表键位
 */
import { useContext, useEffect } from "react";
import { CommandPaletteContext, type CommandPaletteContextValue } from "./context";
import type { ShortcutScope } from "./shortcuts";

export function useCommandPalette(): CommandPaletteContextValue {
  const value = useContext(CommandPaletteContext);
  if (value === null) {
    throw new Error("useCommandPalette must be used inside <CommandPaletteProvider>");
  }
  return value;
}

/**
 * 声明当前激活的快捷键作用域，卸载/关闭时自动撤销。
 * 同一作用域被多个组件同时声明也没问题（内部计数，最后一个撤销才真正失效）。
 */
export function useShortcutScope(scope: ShortcutScope, enabled = true): void {
  const { activateScope } = useCommandPalette();
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    return activateScope(scope);
  }, [activateScope, scope, enabled]);
}
