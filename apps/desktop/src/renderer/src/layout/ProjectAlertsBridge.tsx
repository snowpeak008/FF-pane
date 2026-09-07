import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useActiveProject } from "../hooks/useActiveProject";
import { useSubscription } from "../ipc/useSubscription";
import { isInstantRead, isReadClearingPath, useProjectAlertsStore } from "../stores/project-alerts";

/**
 * 项目落定高亮桥（T9.7）：应用内唯一订阅 tasks:settled，维护 project-alerts store。
 * 照 SessionEventBridge 款式（全局单例、无渲染输出），挂在 App.tsx 的 Router 之内
 * （要读 location）。
 *
 * 两件事：
 * 1. 落定置位——收到事件登记未读；**即时已读例外**（合同语义细节）：活跃项目自己
 *    正开着会话页或任务页时，该项目的新落定不置位（用户正看着，不该先亮再灭）。
 * 2. 已读消除——「切换到该项目 + 打开会话页或任务页任一」即已读：以
 *    (activeRoot, pathname) 为依赖的 effect，两者任一变化时若命中即消除。
 *    点 B 栏条目（切项目 + 跳会话页）与手动切项目后自己点任务页，走的是同一个出口。
 */
export function ProjectAlertsBridge(): null {
  const location = useLocation();
  const { entry } = useActiveProject();
  const recordSettled = useProjectAlertsStore((s) => s.recordSettled);
  const markProjectRead = useProjectAlertsStore((s) => s.markProjectRead);

  const activeRoot = entry?.rootPath ?? null;
  const pathname = location.pathname;

  useSubscription("tasks:settled", (event) => {
    if (isInstantRead(event.projectRoot, activeRoot, pathname)) {
      return;
    }
    recordSettled(event.projectRoot, event.status);
  });

  useEffect(() => {
    if (activeRoot !== null && isReadClearingPath(pathname)) {
      markProjectRead(activeRoot);
    }
  }, [activeRoot, pathname, markProjectRead]);

  return null;
}
