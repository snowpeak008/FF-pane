/**
 * 全局键盘监听（W3.1c）——把 KeyboardEvent 交给注册表解析，命中即执行命令。
 *
 * 三条实现要点：
 * 1. **捕获阶段监听 window**：命中全局键位时 preventDefault + stopPropagation，
 *    事件根本到不了页面的监听器，落实 §7「全局键位优先级最高，页面不得覆盖」。
 *    Esc 例外（preventDefault: false）：最上层浮层的关闭归 radix / 页面自己。
 * 2. **IME 组字期间不解析**：中文输入法组字时按 Enter/方向键属于输入行为，
 *    此时 event.isComposing 为 true，一律放过。
 * 3. **输入框判定**：单字母/无修饰键位在输入框与文本域内失效（§6.4），
 *    判定逻辑在 shortcuts.ts（纯函数，可单测），这里只负责取事件源。
 */
import { useEffect } from "react";
import type { CommandId } from "./ids";
import { isTextInputTarget, type ShortcutRegistry, type ShortcutScope } from "./shortcuts";

export interface GlobalShortcutsOptions {
  readonly registry: ShortcutRegistry;
  readonly activeScopes: readonly ShortcutScope[];
  /** 执行命令；返回 false（无处可执行）时不吃掉事件。 */
  readonly execute: (commandId: CommandId, matchedKey: string) => boolean;
}

export function useGlobalShortcuts(options: GlobalShortcutsOptions): void {
  const { registry, activeScopes, execute } = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) {
        return;
      }
      const target = event.target;
      const match = registry.resolve({
        event,
        activeScopes,
        inTextInput: target instanceof HTMLElement && isTextInputTarget(target),
      });
      if (match === undefined) {
        return;
      }
      if (!execute(match.registration.commandId, match.binding.chord.key)) {
        return;
      }
      if (match.registration.preventDefault) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [registry, activeScopes, execute]);
}
