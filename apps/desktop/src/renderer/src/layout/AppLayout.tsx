import type { ReactElement, ReactNode } from "react";
import { useUiStore } from "../stores/ui";
import { SecondaryPanel } from "./SecondaryPanel";
import { Sidebar } from "./Sidebar";

/**
 * 应用布局骨架（T9.7 起三列）：A 栏（导航侧栏）+ B 栏（次级侧栏，项目切换器）+ 内容列。
 * B 栏是 flex 行内第二个 shrink-0 子项，位置天然跟随 A 栏右缘；A/B 独立收展。
 *
 * 折叠状态（T9.7 收敛）：此前本组件自持 localStorage["ffpane.ui-sidebar-collapsed"]，
 * 与 ui store 的 navCollapsed 双套并存。现收敛进 ui store（persist 迁移见 stores/ui.ts
 * 文件头），本组件只读 store——快捷键（Ctrl+B / Ctrl+Shift+B，§7）经命令面板 handler
 * 走同一套 action，不会再出现两套状态各自为政。
 *
 * 内容列顶部**不由本组件占用**：会话页的常驻状态条、各页面的筛选条属于页面自有头部，
 * 由各页面用 layout/PageHeader 自行渲染（结构上它就是内容列的第一个 flex 子项）。
 *
 * 键盘：**本组件不监听键盘**。全局键位归 command/ 的注册表（§7 全局键位优先级最高），
 * 收展命令的 handler 由 App.tsx 装配层注入。
 */
export interface AppLayoutProps {
  readonly children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps): ReactElement {
  const collapsed = useUiStore((s) => s.navCollapsed);
  const toggleNav = useUiStore((s) => s.toggleNavCollapsed);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas text-fg">
      <Sidebar collapsed={collapsed} onToggle={toggleNav} />
      <SecondaryPanel />
      {/* main 地标：nav（A 栏）/ aside（B 栏）/ main（内容列）三分——语义化之外，
          也让测试能把「页面内容」与「B 栏同名项目条目」区分开 */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
