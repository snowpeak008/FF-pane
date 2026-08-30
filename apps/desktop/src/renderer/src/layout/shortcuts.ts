import { type NavItem, navItemByShortcut } from "./nav";

/**
 * 页面切换快捷键 Ctrl+1 ~ Ctrl+7（设计系统 §7）。
 *
 * 归属声明：**本工单（W3.1b）只实现"页面切换"这一组键位**，注册点在 AppLayout。
 * 全局快捷键框架与命令面板（Ctrl+K / Ctrl+P / Ctrl+, / Ctrl+/ / Alt+←→）属 W3.1c，
 * 两者互不覆盖：这里只认 `Ctrl + 数字`，不拦截任何其它组合，也不做全局注册表。
 */

/** 快捷键匹配所需的最小事件形状，便于纯逻辑单测（不依赖真实 KeyboardEvent）。 */
export interface ShortcutEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** 键位提示串，显示在侧栏 tooltip 右侧（font-mono，不进语言包）。 */
export function shortcutHint(index: number): string {
  return `Ctrl+${index}`;
}

/**
 * 判定一次按键是否为页面切换键，是则返回目标导航项。
 *
 * 规则：
 *  - 必须 Ctrl 且不带 Alt / Shift / Meta（避免与 Ctrl+Shift+A 等页面键位撞车）。
 *  - 只认主键盘的 "1"~"7"；超出七页面范围（如 Ctrl+8）不响应，交回浏览器/其它监听者。
 *  - 输入框内同样生效：Ctrl+数字 不是可打印字符，不存在与打字冲突的问题
 *    （§6.4 里"输入框内失效"的约束只针对单字母快捷键）。
 */
export function matchPageShortcut(event: ShortcutEventLike): NavItem | undefined {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return undefined;
  }
  if (!/^[1-7]$/.test(event.key)) {
    return undefined;
  }
  return navItemByShortcut(Number(event.key));
}
