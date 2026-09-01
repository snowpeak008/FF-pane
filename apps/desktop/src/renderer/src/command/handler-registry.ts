/**
 * 页面自报动作表的纯逻辑（T8.1）——供 CommandPaletteProvider 的 setState 更新器使用。
 *
 * 抽成纯函数而不是写在组件里：这两条规则（重挂载时的注销顺序、与 prop 的合并优先级）
 * 都是"看着显然、错了很难发现"的那类——错了的表现是某个命令在路由往返之后悄悄失效，
 * 而不是抛错。本仓无 @testing-library/react，组件内的逻辑测不到，放这里就能测。
 */
import type { CommandHandlerMap } from "./execute";
import type { CommandId } from "./ids";

/** 登记一个页面动作（同一命令后来者覆盖：页面重挂载时新的那份才是活的）。 */
export function withHandler(
  handlers: CommandHandlerMap,
  commandId: CommandId,
  handler: () => void,
): CommandHandlerMap {
  return { ...handlers, [commandId]: handler };
}

/**
 * 注销一个页面动作，**且只在登记的还是自己那一份时才注销**。
 *
 * 为什么要比对身份：React 卸载旧实例与挂载新实例的顺序是「新的先挂、旧的后卸」
 * （StrictMode 的双调用、路由往返都会走到），若无条件删除，后到的那次注销会把
 * 刚注册上的新 handler 一并抹掉——命令从此静默失效，且只在特定进出顺序下复现。
 */
export function withoutHandler(
  handlers: CommandHandlerMap,
  commandId: CommandId,
  handler: () => void,
): CommandHandlerMap {
  if (handlers[commandId] !== handler) {
    return handlers;
  }
  const next = { ...handlers };
  delete next[commandId];
  return next;
}

/**
 * 合并页面自报的动作与挂载方经 prop 给的动作，**prop 优先**。
 * 挂载方是集成方，它显式给的动作不该被某个页面悄悄顶掉。
 */
export function mergeHandlers(
  pageHandlers: CommandHandlerMap,
  propHandlers: CommandHandlerMap,
): CommandHandlerMap {
  return { ...pageHandlers, ...propHandlers };
}
