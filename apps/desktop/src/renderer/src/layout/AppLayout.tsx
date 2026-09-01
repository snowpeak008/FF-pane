import { type ReactElement, type ReactNode, useCallback, useState } from "react";
import { Sidebar } from "./Sidebar";

/**
 * 侧栏折叠状态的持久化 key。
 * 与主题（ffpane.ui-theme）、语言（ffpane.ui-language）同一先例：Phase 3 暂存 localStorage，
 * 后续接入全局 config.json 时唯一改动点是这两个读写函数。
 */
const SIDEBAR_STORAGE_KEY = "ffpane.ui-sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    // 隐私模式等读不到 localStorage 的场景一律按展开处理，不影响可用性
    return false;
  }
}

function persistCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
  } catch (thrown) {
    console.error("[renderer] persisting sidebar state failed:", thrown);
  }
}

export interface AppLayoutProps {
  readonly children: ReactNode;
}

/**
 * 应用布局骨架：左侧导航 + 右侧内容列。
 *
 * 内容列顶部**不由本组件占用**：会话页的常驻状态条、各页面的筛选条属于页面自有头部，
 * 由各页面用 layout/PageHeader 自行渲染（结构上它就是内容列的第一个 flex 子项）。
 *
 * 键盘：**本组件不监听键盘**。Ctrl+1~7 的页面切换归 command/ 的全局注册表
 * （`nav-page-by-index`，全局作用域），§7 定的就是「全局键位优先级最高，页面不得覆盖」。
 *
 * 此前这里另挂了一条 window keydown 做同一件事。T8.1 删除它的理由不是"会跳两次"
 * ——实测并不会：注册表那条挂在**捕获阶段**且命中即 stopPropagation，本处的冒泡监听
 * 根本收不到 Ctrl+N。也就是说它早已是事实上的死代码，而它的"无害"完全依赖于
 * 远处另一个文件恰好用了捕获阶段：那边哪天改走冒泡，这里就会立刻变成跳两次。
 * 同一组键位留两个实现本身就是隐患，与它今天有没有生效无关。
 */
export function AppLayout({ children }: AppLayoutProps): ReactElement {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);

  const toggleSidebar = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous;
      persistCollapsed(next);
      return next;
    });
  }, []);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas text-fg">
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
