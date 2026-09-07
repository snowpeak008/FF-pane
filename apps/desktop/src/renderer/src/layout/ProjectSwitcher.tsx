import type { ProjectRegistryEntry } from "@ff-pane/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { TaskSettledStatus } from "../../../shared-ipc/contracts";
import { BADGE_DOT_BASE, TASK_STATUS_BADGE } from "../components/ui/badge.variants";
import { Tooltip } from "../components/ui/Tooltip";
import { cn } from "../lib/cn";
import { useProjectAlertsStore } from "../stores/project-alerts";
import { useUiStore } from "../stores/ui";

/**
 * 项目快速切换器（T9.7 B 栏首要内容，合同 v1.16）。
 *
 * - 常驻显示全部项目；每项截断短名，悬停 tooltip 全名（照 Sidebar 收起态款式：
 *   Tooltip side="right"）。
 * - 点击 = 一步完成「切换活跃项目 + 会话窗口切到该项目」：setActiveProjectId +
 *   navigate("/session")——与项目页「选中卡片 + toast 去会话页」同一条链（T9.6 ③），
 *   不另造选中逻辑；会话页的自动续接 / 回放（T8.2b）照常生效。已读消除不在这里做：
 *   归 ProjectAlertsBridge 的路由 effect（导航到 /session 后统一判定），单一出口。
 * - 落定高亮（未读）：右侧按状态显示圆点（failed / blocked / done 序——失败与阻塞
 *   比完成更需要被看见，且三色分别取 §3.3 状态色），名字加重。与活跃选中态
 *   （左侧 2px primary 边条 + bg-surface-active，照 SidebarLink §5.6）视觉区分。
 */
export function ProjectSwitcher({
  entries,
}: {
  readonly entries: readonly ProjectRegistryEntry[];
}): ReactElement {
  const { t } = useTranslation();
  return (
    <ul
      className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
      aria-label={t("secondaryPanel.projects")}
    >
      {entries.map((entry) => (
        <li key={entry.id}>
          <ProjectSwitcherItem entry={entry} />
        </li>
      ))}
    </ul>
  );
}

/** 未读圆点的呈现序：危急优先（失败 > 阻塞 > 完成）。 */
const ALERT_DOT_ORDER: readonly TaskSettledStatus[] = ["failed", "blocked", "done"];

function ProjectSwitcherItem({ entry }: { readonly entry: ProjectRegistryEntry }): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);
  const unread = useProjectAlertsStore((s) => s.alerts[entry.rootPath]);

  const isActive = entry.id === activeProjectId;
  const hasAlert = unread !== undefined && unread.length > 0;
  const dots = hasAlert ? ALERT_DOT_ORDER.filter((status) => unread.includes(status)) : [];

  const open = (): void => {
    setActiveProjectId(entry.id);
    void navigate("/session");
  };

  return (
    <Tooltip content={entry.name} side="right">
      <button
        type="button"
        // 可访问名用动作语义（「切换到项目：X」）而非裸项目名：按钮名该说明按下会发生
        // 什么；也让 B 栏条目与项目页卡片（可访问名以项目名开头）在角色查询里天然可分
        aria-label={t("secondaryPanel.switchTo", { name: entry.name })}
        aria-current={isActive ? "true" : undefined}
        onClick={open}
        className={cn(
          "flex h-7 w-full min-w-0 items-center gap-2 rounded-sm border-l-2 border-l-transparent px-2",
          "text-left text-sm text-fg-muted transition-colors duration-100",
          "hover:bg-surface-hover hover:text-fg",
          isActive && "border-l-primary bg-surface-active font-medium text-fg",
          hasAlert && "font-medium text-fg",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {dots.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1">
            {dots.map((status) => (
              <span
                key={status}
                role="status"
                aria-label={t(`secondaryPanel.settled.${status}`)}
                className={cn(BADGE_DOT_BASE, TASK_STATUS_BADGE[status].dot)}
              />
            ))}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}
