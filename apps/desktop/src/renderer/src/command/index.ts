/**
 * command 模块出口（W3.1c）—— 全局快捷键框架 + 命令面板。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 挂载现状（T8.1 已接线）
 * ════════════════════════════════════════════════════════════════════════════
 * 本模块自足：不 import components / layout / pages / router，只依赖
 * lib/cn、stores/pages（页面 key 词表）与 i18n。
 *
 * 实际挂载点是 `App.tsx` 的 `<CommandPaletteProvider>`（在 HashRouter 之内——
 * 命令项要 navigate），navigate 的实现由它接 react-router（本模块不知道路由长什么样）。
 *
 * **页面切换键位（Ctrl+1~7）只此一处**：注册表的 `nav-page-by-index` 是全局作用域，
 * AppLayout 此前那条自建的 `window.addEventListener("keydown")` 已在 T8.1 删除。
 * 删除理由不是「会跳两次」——实测并不会：本模块的监听挂在 window **捕获阶段**且命中即
 * stopPropagation，冒泡侧那条根本收不到 Ctrl+N，早已是事实上的死代码。删它是因为同一组
 * 键位留两个实现本身就是隐患：它的「无害」完全依赖本模块恰好用了捕获阶段，这边哪天改走
 * 冒泡，那边立刻变成跳两次。§7 定的是「全局键位优先级最高，页面不得覆盖」。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 页面工单怎么接
 * ════════════════════════════════════════════════════════════════════════════
 *   - 声明作用域：useShortcutScope("session")、useShortcutScope("list", hasFocus)；
 *     不声明的作用域内的键位不会触发。
 *   - 接入动作，两条路二选一：
 *       · 动作在页面组件内部（要开的对话框状态就住在那里）→ 页面自报：
 *            useCommandHandler("session-insert-knowledge", () => setOpen(true));
 *       · 挂载方本就知道怎么做 → 经 Provider 的 handlers prop 给（同名时 prop 优先）。
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
export { mergeHandlers, withHandler, withoutHandler } from "./handler-registry";
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
export { useCommandHandler, useCommandPalette, useShortcutScope } from "./useCommandPalette";
export { type GlobalShortcutsOptions, useGlobalShortcuts } from "./useGlobalShortcuts";
