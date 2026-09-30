import type { ProjectRegistryEntry } from "@ff-pane/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import type { TaskSettledStatus } from "../../../shared-ipc/contracts";
import { BADGE_DOT_BASE, TASK_STATUS_BADGE } from "../components/ui/badge.variants";
import { Tooltip } from "../components/ui/Tooltip";
import { cn } from "../lib/cn";
import { useProjectAlertsStore } from "../stores/project-alerts";
import { useUiStore } from "../stores/ui";
import { useWorkbenchStore } from "../stores/workbench";

/**
 * 项目快速切换器（T9.7 B 栏；T10.2 增窗口数 + 工作台页内切换不跳会话）。
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

const ALERT_DOT_ORDER: readonly TaskSettledStatus[] = ["failed", "blocked", "done"];

function ProjectSwitcherItem({ entry }: { readonly entry: ProjectRegistryEntry }): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);
  const unread = useProjectAlertsStore((s) => s.alerts[entry.rootPath]);
  const windowCount = useWorkbenchStore(
    (s) => Object.keys(s.layoutsByProject[entry.id]?.windows ?? {}).length,
  );

  const isActive = entry.id === activeProjectId;
  const hasAlert = unread !== undefined && unread.length > 0;
  const dots = hasAlert ? ALERT_DOT_ORDER.filter((status) => unread.includes(status)) : [];
  const onWorkbench =
    location.hash.includes("/workbench") || location.pathname.includes("workbench");

  const open = (): void => {
    setActiveProjectId(entry.id);
    // 工作台内切项目只换视图，不杀其它项目 PTY；其它页面仍进会话
    void navigate(onWorkbench ? "/workbench" : "/session");
  };

  return (
    <Tooltip content={entry.name} side="right">
      <button
        type="button"
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
        {windowCount > 0 ? (
          <span
            className="shrink-0 font-mono text-2xs text-fg-subtle"
            data-testid="project-window-count"
            title={t("secondaryPanel.windowCount", { count: windowCount })}
          >
            {windowCount}
          </span>
        ) : null}
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
