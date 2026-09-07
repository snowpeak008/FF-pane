import type { ProjectRegistryEntry } from "@ff-pane/shared";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { type ReactElement, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/Button";
import { Tooltip } from "../components/ui/Tooltip";
import { queryData } from "../ipc/query";
import { useInvokeQuery } from "../ipc/useInvokeQuery";
import { cn } from "../lib/cn";
import { useUiStore } from "../stores/ui";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { useSecondaryPanel } from "./secondary-panel";

/** 展开态 176px / 收起态 32px，均为 4 的倍数（设计系统 §4.1）。 */
const SECONDARY_PANEL_WIDTH = { expanded: "w-44", collapsed: "w-8" } as const;

/** 稳定空列表（查询未就绪时不每帧新建数组）。 */
const EMPTY_ENTRIES: readonly ProjectRegistryEntry[] = [];

/**
 * B 栏（T9.7）：A 栏右缘的次级侧栏，flex 行内第二个 shrink-0 子项——位置天然跟随
 * A 栏右缘，无需定位计算。与 A 栏独立收展（ui store secondaryPanelCollapsed，
 * Ctrl+Shift+B）。设计系统对齐：无阴影 1px 边框（§4.5，border-r 与 A 栏同款）、
 * 瞬时切换无动画（§4.6）。
 *
 * **项目列表为空时整栏隐藏**（合同 v1.16：有项目即常显）：数据源 projects:list
 * （轻通道，B 栏只要名字；summary 的四处扫盘不该为一个常驻栏买单）。项目增删
 * 发生在项目页，经 ui store 的 projectsRefreshSeq 信号触发重取。
 *
 * 内容：默认为项目快速切换器；页面经 SecondaryPanelProvider 投送的内容优先
 * （后续可选批次的迁移入口，本单无消费方）。
 */
export function SecondaryPanel(): ReactElement | null {
  const { t } = useTranslation();
  const collapsed = useUiStore((s) => s.secondaryPanelCollapsed);
  const toggle = useUiStore((s) => s.toggleSecondaryPanelCollapsed);
  const refreshSeq = useUiStore((s) => s.projectsRefreshSeq);
  const { content } = useSecondaryPanel();
  const { state, refetch } = useInvokeQuery("projects:list");
  const entries = useMemo(() => queryData(state) ?? EMPTY_ENTRIES, [state]);

  // 项目增删信号：seq 变了就重取（refetch 引用稳定，effect 只随 seq 触发）
  useEffect(() => {
    if (refreshSeq > 0) {
      refetch();
    }
  }, [refreshSeq, refetch]);

  // 合同：项目列表为空时整栏隐藏。加载中 / 出错也不占位——B 栏是辅助导航，
  // 它的错误不值得一块常驻的错误面板（项目页有完整三态）。
  if (entries.length === 0) {
    return null;
  }

  const toggleLabel = collapsed ? t("secondaryPanel.expand") : t("secondaryPanel.collapse");
  const ToggleIcon = collapsed ? PanelRightOpen : PanelRightClose;

  return (
    <aside
      aria-label={t("secondaryPanel.label")}
      className={cn(
        // 宽度不做过渡：§4.6 瞬时切换；§4.5 无阴影、1px 边框
        "flex shrink-0 flex-col gap-1 border-r border-border bg-surface p-2",
        collapsed ? SECONDARY_PANEL_WIDTH.collapsed : SECONDARY_PANEL_WIDTH.expanded,
      )}
    >
      <div
        className={cn("flex h-7 items-center", collapsed ? "justify-center" : "justify-between")}
      >
        {collapsed ? null : (
          <span className="truncate px-1 text-xs font-medium text-fg-muted">
            {t("secondaryPanel.projects")}
          </span>
        )}
        <Tooltip content={toggleLabel} side="right" shortcut="Ctrl+Shift+B">
          <Button variant="ghost" size="sm" iconOnly aria-label={toggleLabel} onClick={toggle}>
            <ToggleIcon aria-hidden size={14} />
          </Button>
        </Tooltip>
      </div>
      {collapsed ? null : (content ?? <ProjectSwitcher entries={entries} />)}
    </aside>
  );
}
