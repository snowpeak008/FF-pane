/**
 * 命令面板与快捷键作用域的消费 hook（W3.1c）。
 *
 * 页面工单用法：
 *   const { openPalette } = useCommandPalette();     // 工具栏按钮打开面板
 *   useShortcutScope("session");                     // 本页面激活「会话页」作用域
 *   useShortcutScope("list", listHasFocus);          // 列表获得焦点时才激活列表键位
 *   useCommandHandler("session-insert-knowledge", open);  // 本页面接入一个动作（T8.1）
 */
import { useContext, useEffect, useRef } from "react";
import { CommandPaletteContext, type CommandPaletteContextValue } from "./context";
import type { CommandId } from "./ids";
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

/**
 * 把本页面的一个动作接入命令面板与快捷键，卸载时自动注销（T8.1）。
 *
 * handler 存 ref 后注册一层薄包装：页面每次渲染都会新建一个箭头函数，
 * 若直接注册就会每渲染一次注销重注册一轮——而注册会 setState，于是渲染又被触发。
 * 包装身份恒定，注册只发生在挂载时。
 */
export function useCommandHandler(commandId: CommandId, handler: () => void): void {
  const { registerCommand } = useCommandPalette();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(
    () => registerCommand(commandId, () => handlerRef.current()),
    [registerCommand, commandId],
  );
}
