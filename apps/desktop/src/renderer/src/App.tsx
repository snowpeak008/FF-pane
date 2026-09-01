import type { ProjectRegistryEntry } from "@ff-pane/shared";
import { type ReactElement, useCallback, useMemo } from "react";
import { HashRouter, useNavigate } from "react-router-dom";
import { Toaster } from "sonner";
import { CommandPaletteProvider, type NavigationTarget, type PaletteProjectItem } from "./command";
import { TooltipProvider } from "./components/ui/Tooltip";
import { queryData } from "./ipc/query";
import { useInvokeQuery } from "./ipc/useInvokeQuery";
import { AppLayout } from "./layout/AppLayout";
import { navItemById } from "./layout/nav";
import { AppRoutes } from "./pages/AppRoutes";
import { HabitSuggestionBridge } from "./pages/session/HabitSuggestionBridge";
import { SessionEventBridge } from "./pages/session/SessionEventBridge";
import { useUiStore } from "./stores/ui";
import { useTheme } from "./theme";

/**
 * 应用装配（W3.1b；T8.1 补入命令面板）。
 *
 * 层次固定为：ThemeProvider（在 main.tsx，先于 React 挂载即已上色）
 *   → HashRouter → TooltipProvider → CommandPaletteProvider → AppLayout → 路由内容。
 *
 * 为什么是 HashRouter：生产构建经 `loadFile` 以 file:// 协议加载（见 src/main/index.ts），
 * BrowserRouter 依赖的 history pushState 在 file:// 下拿不到可用的路径基准；
 * 且主进程的 will-navigate 守卫会拦下离开应用的导航。hash 路由两边都成立。
 */
/**
 * 全局通知（sonner）。§6.3 可撤销操作：立即执行 + toast + 撤销，停留 5s。
 * 主题跟随当前解析主题（浅/深），保持双主题一致；无装饰（closeButton、纯色）。
 */
function AppToaster(): ReactElement {
  const { resolvedTheme } = useTheme();
  return <Toaster theme={resolvedTheme} position="bottom-right" duration={5000} closeButton />;
}

/** 稳定的空列表：查询未就绪时不要每次渲染都新建一个数组，否则下游 memo 全部失效。 */
const EMPTY_ENTRIES: readonly ProjectRegistryEntry[] = [];

/**
 * 命令面板的装配层（T8.1）——必须在 Router 之内：命令项要跳路由。
 *
 * 项目模式（Ctrl+P）走 `projects:list` 而不是 `projects:summary`：面板只显示名字与
 * 路径，而 summary 要为每个项目扫四处磁盘（见 contracts.ts 该通道注释）。选中即
 * 「设为当前项目」，与项目列表页点卡片同一语义（hooks/useActiveProject 消费）。
 */
function AppCommandPalette({ children }: { readonly children: ReactElement }): ReactElement {
  const navigate = useNavigate();
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);
  const { state } = useInvokeQuery("projects:list");
  const entries = useMemo(() => queryData(state) ?? EMPTY_ENTRIES, [state]);

  const projects = useMemo<readonly PaletteProjectItem[]>(
    () => entries.map((entry) => ({ id: entry.id, name: entry.name, path: entry.rootPath })),
    [entries],
  );

  const handleNavigate = useCallback(
    (target: NavigationTarget) => {
      if (target.kind === "history") {
        void navigate(target.direction === "back" ? -1 : 1);
        return;
      }
      void navigate(navItemById(target.page).path);
    },
    [navigate],
  );

  // 面板给回的是裸字符串 id；回注册表里取那一条，用它自带的品牌化 ProjectId，
  // 免得在这里凭空 as 一次（品牌 ID 只在 JSON 边界收窄，见开发进度 §5 工程约定）。
  const handleSelectProject = useCallback(
    (projectId: string) => {
      const entry = entries.find((candidate) => candidate.id === projectId);
      if (entry !== undefined) {
        setActiveProjectId(entry.id);
      }
    },
    [entries, setActiveProjectId],
  );

  return (
    <CommandPaletteProvider
      navigate={handleNavigate}
      projects={projects}
      onSelectProject={handleSelectProject}
    >
      {children}
    </CommandPaletteProvider>
  );
}

export function App(): ReactElement {
  return (
    <HashRouter>
      <TooltipProvider>
        <AppCommandPalette>
          <AppLayout>
            <AppRoutes />
          </AppLayout>
        </AppCommandPalette>
        {/* 会话流式事件全局订阅桥（T4.2）：唯一订阅 session:event，归并进 store。 */}
        <SessionEventBridge />
        {/* 系统观察建议全局桥（T5.4 来源三）：唯一订阅 habits:suggestion，提示 observed 候选。 */}
        <HabitSuggestionBridge />
        <AppToaster />
      </TooltipProvider>
    </HashRouter>
  );
}
