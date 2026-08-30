import type { ReactElement } from "react";
import { HashRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { TooltipProvider } from "./components/ui/Tooltip";
import { AppLayout } from "./layout/AppLayout";
import { AppRoutes } from "./pages/AppRoutes";
import { HabitSuggestionBridge } from "./pages/session/HabitSuggestionBridge";
import { SessionEventBridge } from "./pages/session/SessionEventBridge";
import { useTheme } from "./theme";

/**
 * 应用装配（W3.1b）。
 *
 * 层次固定为：ThemeProvider（在 main.tsx，先于 React 挂载即已上色）
 *   → HashRouter → TooltipProvider → AppLayout → 路由内容。
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

export function App(): ReactElement {
  return (
    <HashRouter>
      <TooltipProvider>
        <AppLayout>
          <AppRoutes />
        </AppLayout>
        {/* 会话流式事件全局订阅桥（T4.2）：唯一订阅 session:event，归并进 store。 */}
        <SessionEventBridge />
        {/* 系统观察建议全局桥（T5.4 来源三）：唯一订阅 habits:suggestion，提示 observed 候选。 */}
        <HabitSuggestionBridge />
        <AppToaster />
        {/*
          命令面板挂载位（W3.1c，待接线）：Ctrl+K 面板与全局快捷键注册器将挂在这里
          （需在 Router 内以便命令项 navigate）。接线时需先解决 Ctrl+1~7 与 AppLayout
          既有页面快捷键的重复处理问题，故留待独立一步。
        */}
      </TooltipProvider>
    </HashRouter>
  );
}
