/** 应用布局出口：页面工单从这里取 PageHeader 与导航表，不引用内部文件。 */
export { AppLayout, type AppLayoutProps } from "./AppLayout";
export {
  ALL_NAV_ITEMS,
  type AnyNavId,
  DEFAULT_ROUTE_PATH,
  NAV_IDS,
  NAV_ITEMS,
  type NavId,
  type NavItem,
  navItemById,
  SETTINGS_NAV_ITEM,
} from "./nav";
export { NAV_ICONS } from "./nav-icons";
export { PageHeader, type PageHeaderProps } from "./PageHeader";
export { Sidebar, type SidebarProps } from "./Sidebar";
export { shortcutHint } from "./shortcuts";
