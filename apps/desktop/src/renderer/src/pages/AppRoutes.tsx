import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ALL_NAV_ITEMS, DEFAULT_ROUTE_PATH } from "../layout/nav";
import { KnowledgePage } from "./knowledge";
import { MemoryPage } from "./memory";
import { NotFoundPage } from "./NotFoundPage";
import { PlaceholderPage } from "./PlaceholderPage";
import { ProjectsPage } from "./projects";
import { SettingsPage } from "./settings";
import { WorkbenchPage } from "./workbench";

/**
 * 路由表（react-router-dom v7）。
 *
 * 主页面 + 设置由 layout/nav.ts 的导航表派生，
 * 保证「侧栏条目 / 路由 / Ctrl+N / 占位文案」四者永不脱节。
 * 各页面工单接手时，把对应 id 接入 PAGE_ELEMENTS 即可（已接入的用真实页面，
 * 未接入的回落到 PlaceholderPage），路径不要另起。
 */
const PAGE_ELEMENTS: Partial<Record<string, ReactElement>> = {
  knowledge: <KnowledgePage />,
  memory: <MemoryPage />,
  projects: <ProjectsPage />,
  settings: <SettingsPage />,
  workbench: <WorkbenchPage />,
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
