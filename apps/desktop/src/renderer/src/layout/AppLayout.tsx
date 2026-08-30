import { type ReactElement, type ReactNode, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { matchPageShortcut } from "./shortcuts";

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
 * 键盘：这里注册 Ctrl+1 ~ Ctrl+7 的页面切换（设计系统 §7）。
 * 归属边界见 shortcuts.ts —— 全局键位框架与命令面板由 W3.1c 负责，本处不建注册表、
 * 不拦截任何非 `Ctrl+数字` 的组合，两侧监听器可以共存。
 */
export function AppLayout({ children }: AppLayoutProps): ReactElement {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);

  const toggleSidebar = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous;
      persistCollapsed(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = matchPageShortcut(event);
      if (target === undefined) {
        return;
      }
      event.preventDefault();
      void navigate(target.path);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas text-fg">
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
