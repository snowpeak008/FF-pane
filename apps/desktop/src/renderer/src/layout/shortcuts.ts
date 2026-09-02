/**
 * 侧栏的键位提示串（设计系统 §7 的 Ctrl+1 ~ Ctrl+7）。
 *
 * **本文件不再做键位匹配**：原先这里有一个 `matchPageShortcut`，供 AppLayout 自建的
 * window keydown 监听判定页面切换键。命令面板挂进 App.tsx（T8.1）之后，同一组键位
 * 在 command/ 的全局注册表里也有一份（`nav-page-by-index`）。实测两者并存**并不会**
 * 跳两页——注册表那条挂在捕获阶段且命中即 stopPropagation，冒泡侧的监听收不到——
 * 但同一组键位留两个实现本身就是隐患（其「无害」依赖远处另一个文件恰好用了捕获阶段），
 * 故那条监听与这个函数一并删除——页面切换的判定只此一处（注册表）。
 * 这里只剩「把序号渲染成提示文字」这一件事，它与判定无关，侧栏 tooltip 还要用。
 * 同理，`nav.ts` 的 `navItemByShortcut`（原本只被 `matchPageShortcut` 消费）也随之删除。
 *
 * 序号本身来自 `stores/pages.ts` 的页面注册表（经 nav.ts 的 `NavItem.shortcut`），
 * 不在本文件另定义。
 */

/** 键位提示串，显示在侧栏 tooltip 右侧（font-mono，不进语言包）。 */
export function shortcutHint(index: number): string {
  return `Ctrl+${index}`;
}
