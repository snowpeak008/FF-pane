/**
 * command 模块出口（W3.1c）—— 全局快捷键框架 + 命令面板。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 集成说明（给主管理员 / T3.1）
 * ════════════════════════════════════════════════════════════════════════════
 * 本模块自足：不 import components / layout / pages / router，只依赖
 * lib/cn、stores/pages（页面 key 词表）与 i18n。挂载只需两步：
 *
 *   1. 在 React 树最外层（ThemeProvider 之内）包一层 Provider，注入 navigate：
 *
 *        <CommandPaletteProvider navigate={handleNavigate} handlers={pageHandlers}>
 *          <AppLayout />
 *        </CommandPaletteProvider>
 *
 *      navigate 的实现由集成方接 W3.1b 的路由（本模块不知道路由长什么样）：
 *
 *        const handleNavigate = (target: NavigationTarget) => {
 *          if (target.kind === "history") {
 *            navigate(target.direction === "back" ? -1 : 1);
 *            return;
 *          }
 *          navigate(routeOf(target.page));   // PageKey → 路由路径的映射归集成方
 *        };
 *
 *   2. 需要在界面上给一个入口按钮时（§6.4 可发现性）：
 *
 *        const { openPalette } = useCommandPalette();
 *        <Button onClick={() => openPalette()} />   // 键位提示用 Ctrl+K
 *
 * 面板是 portal 浮层，不占布局位置；W3.1b 的预留槽位只需能包住子树即可。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 页面工单怎么接
 * ════════════════════════════════════════════════════════════════════════════
 *   - 声明作用域：useShortcutScope("session")、useShortcutScope("list", hasFocus)；
 *     不声明的作用域内的键位不会触发。
 *   - 接入动作：把 handlers 传给 Provider（集成方汇总），键为命令 ID：
 *        { "session-send": sendMessage, "tasks-dispatch": dispatchFocusedTask }
 *     未接入的命令在面板里可搜到、显示键位、标注「待接入」且不可点。
 *   - 新增键位：先改 docs/设计系统.md §7 → 再改 shortcuts.ts 的 SHORTCUT_TABLE
 *     → 再补 ids.ts 与两个语言包（command.item.* / shortcut.action.*）。
 *     键位撞车在注册阶段就抛 ShortcutConflictError，不会静默失效。
 */
export { CommandPalette, type PaletteProjectItem } from "./CommandPalette";
export { CommandPaletteProvider, type CommandPaletteProviderProps } from "./CommandPaletteProvider";
export {
  COMMAND_BY_ID,
  COMMAND_GROUPS,
  COMMAND_TABLE,
  type CommandDescriptor,
  type CommandGroup,
  commandShortcutDisplay,
  commandsInGroup,
  type NavigationTarget,
} from "./commands";
export { CommandPaletteContext, type CommandPaletteContextValue } from "./context";
export {
  type CommandHandlerMap,
  type CommandRuntime,
  executeCommand,
  isCommandRunnable,
  type PaletteMode,
  paletteModeOf,
} from "./execute";
export {
  COMMAND_IDS,
  type CommandId,
  commandKeywordsKey,
  commandTitleKey,
  isCommandId,
  shortcutActionKey,
} from "./ids";
export {
  filterBySearch,
  type SearchableFields,
  scoreField,
  scoreSearchMatch,
} from "./search";
export {
  chordId,
  chordIdFromEvent,
  createShortcutRegistry,
  formatKeyChord,
  formatShortcutSpec,
  isTextInputTarget,
  type KeyboardEventLike,
  type KeyChord,
  normalizeEventKey,
  parseKeyChord,
  SHORTCUT_SCOPES,
  SHORTCUT_TABLE,
  SHORTCUT_TABLE_SIZE,
  type ShortcutBinding,
  ShortcutConflictError,
  type ShortcutMatch,
  type ShortcutRegistration,
  type ShortcutRegistry,
  type ShortcutResolveContext,
  type ShortcutScope,
  type TextInputTargetLike,
} from "./shortcuts";
export { useCommandPalette, useShortcutScope } from "./useCommandPalette";
export { type GlobalShortcutsOptions, useGlobalShortcuts } from "./useGlobalShortcuts";
