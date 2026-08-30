/**
 * 页面标识词表（W3.1c）——七个页面 + 设置页（项目设计计划 §11）。
 *
 * 为什么单独一个文件：命令面板（command/）与 ui store 都要用页面 key，
 * 但命令面板不该为了一个字符串联合把 zustand 拖进依赖；本文件零依赖、可直接单测。
 * 路由路径不在这里——路由是 W3.1b/T3.1 的事，本层只给"页面身份"，
 * 具体跳转由挂载时注入的 navigate 回调完成（命令面板不 import router）。
 */

/** 七个页面（§11.1~§11.7）+ 设置页。顺序即侧栏顺序。 */
export const PAGE_KEYS = [
  "projects",
  "session",
  "plan",
  "tasks",
  "runs",
  "memory",
  "knowledge",
  "settings",
] as const;

export type PageKey = (typeof PAGE_KEYS)[number];

/**
 * Ctrl+1 ~ Ctrl+7 的页面顺序（设计系统 §7 快捷键表）。
 * 设置页不在其中——它走 Ctrl+,。
 */
export const PAGE_SHORTCUT_ORDER = [
  "projects",
  "session",
  "plan",
  "tasks",
  "runs",
  "memory",
  "knowledge",
] as const satisfies readonly PageKey[];

const PAGE_KEY_SET: ReadonlySet<string> = new Set(PAGE_KEYS);

export function isPageKey(value: string): value is PageKey {
  return PAGE_KEY_SET.has(value);
}

/** 按 Ctrl+N 的序号（1 起）取页面；越界返回 undefined。 */
export function pageKeyByShortcutIndex(index: number): PageKey | undefined {
  return PAGE_SHORTCUT_ORDER[index - 1];
}

/** 页面在 Ctrl+N 里的序号（1 起）；设置页无序号，返回 undefined。 */
export function shortcutIndexOfPage(page: PageKey): number | undefined {
  const index = PAGE_SHORTCUT_ORDER.indexOf(page as (typeof PAGE_SHORTCUT_ORDER)[number]);
  return index < 0 ? undefined : index + 1;
}
