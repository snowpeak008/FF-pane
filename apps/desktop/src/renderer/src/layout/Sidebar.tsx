import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useMatch } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Separator } from "../components/ui/Separator";
import { Tooltip } from "../components/ui/Tooltip";
import { cn } from "../lib/cn";
import { NAV_ITEMS, type NavItem, SETTINGS_NAV_ITEM } from "./nav";
import { NAV_ICONS } from "./nav-icons";
import { shortcutHint } from "./shortcuts";

/** 展开态 208px / 收起态 48px，均为 4 的倍数（设计系统 §4.1）。 */
const SIDEBAR_WIDTH = { expanded: "w-52", collapsed: "w-12" } as const;

/** 产品名不进语言包：品牌名不翻译。 */
const BRAND = "FF-pane";

export interface SidebarProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

/**
 * 侧边导航（项目设计计划 §11 的七个页面 + 底部设置入口）。
 *
 * - 宽窄两态：收起后只留 16px 图标，标签与键位靠 tooltip 提供（§6.4 可发现性）。
 * - 选中态沿用列表行的规范（§5.6）：bg-surface-active + 左侧 2px primary 边条；
 *   未选中项也占同样宽度的透明边条，切换时不产生位移。
 */
export function Sidebar({ collapsed, onToggle }: SidebarProps): ReactElement {
  const { t } = useTranslation();
  const toggleLabel = collapsed ? t("nav.expand") : t("nav.collapse");
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <nav
      aria-label={t("nav.primary")}
      className={cn(
        // 宽度不做过渡：§4.6 明确禁止 layout 动画，折叠是瞬时切换
        "flex shrink-0 flex-col gap-1 border-r border-border bg-surface p-2",
        collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded,
      )}
    >
      <div
        className={cn("flex h-7 items-center", collapsed ? "justify-center" : "justify-between")}
      >
        {collapsed ? null : (
          <span className="truncate px-1 text-sm font-semibold text-fg">{BRAND}</span>
        )}
        <Tooltip content={toggleLabel} side="right">
          <Button variant="ghost" size="sm" iconOnly aria-label={toggleLabel} onClick={onToggle}>
            <ToggleIcon aria-hidden size={14} />
          </Button>
        </Tooltip>
      </div>

      <Separator className="my-1" />

      <ul className="flex min-h-0 flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <SidebarLink item={item} collapsed={collapsed} />
          </li>
        ))}
      </ul>

      <Separator className="my-1" />
      <SidebarLink item={SETTINGS_NAV_ITEM} collapsed={collapsed} />
    </nav>
  );
}

function SidebarLink({
  item,
  collapsed,
}: {
  readonly item: NavItem;
  readonly collapsed: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const Icon = NAV_ICONS[item.id];
  const label = t(item.labelKey);
  const hint = item.shortcut === undefined ? undefined : shortcutHint(item.shortcut);
  // className 必须是字符串：NavLink 的函数形态在 radix Slot（Tooltip.Trigger asChild）
  // 合并 props 时会被当成普通值拼进 class 串，导致整条样式失效。选中态改由 useMatch 判定。
  const isActive = useMatch(item.path) !== null;

  return (
    <Tooltip content={label} side="right" {...(hint === undefined ? {} : { shortcut: hint })}>
      <NavLink
        to={item.path}
        aria-label={label}
        className={cn(
          "flex h-7 items-center gap-2 rounded-sm border-l-2 border-l-transparent",
          "text-sm text-fg-muted transition-colors duration-100",
          "hover:bg-surface-hover hover:text-fg",
          collapsed ? "justify-center px-0" : "px-2",
          isActive && "border-l-primary bg-surface-active font-medium text-fg",
        )}
      >
        <Icon aria-hidden className="shrink-0" size={16} />
        {collapsed ? null : <span className="truncate">{label}</span>}
      </NavLink>
    </Tooltip>
  );
}
