import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ALL_NAV_ITEMS, DEFAULT_ROUTE_PATH } from "../layout/nav";
import { NotFoundPage } from "./NotFoundPage";
import { PlaceholderPage } from "./PlaceholderPage";
import { ProjectsPage } from "./projects";
import { SettingsPage } from "./settings";

/**
 * 路由表（react-router-dom v7）。
 *
 * 八条路由（七个页面 + 设置）由 layout/nav.ts 的导航表派生，
 * 保证「侧栏条目 / 路由 / Ctrl+1~7 / 占位文案」四者永不脱节。
 * 各页面工单接手时，把对应 id 接入 PAGE_ELEMENTS 即可（已接入的用真实页面，
 * 未接入的回落到 PlaceholderPage），路径不要另起。
 */
const PAGE_ELEMENTS: Partial<Record<string, ReactElement>> = {
  projects: <ProjectsPage />,
  settings: <SettingsPage />,
};

export function AppRoutes(): ReactElement {
  return (
    <Routes>
      <Route path="/" element={<Navigate replace to={DEFAULT_ROUTE_PATH} />} />
      {ALL_NAV_ITEMS.map((item) => (
        <Route
          key={item.id}
          path={item.path}
          element={PAGE_ELEMENTS[item.id] ?? <PlaceholderPage item={item} />}
        />
      ))}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
