/**
 * 冒烟 1：应用启动（§13 清单 #1 的启动侧）。
 *
 * 断言构建产物能启动、单窗口可见、默认路由（/projects）渲染成功，
 * 且 projects:list 的 IPC 往返落地为空态文案——证明 main↔renderer 数据链路通。
 */

import { expect, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched.cleanup();
});

test("应用启动并渲染默认项目页空态", async () => {
  const { app, page } = launched;

  // 单窗口应用：恰好一个渲染窗口
  expect(app.windows()).toHaveLength(1);

  // 默认路由重定向到 /projects
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain("/projects");

  // 页头标题 + 空态文案（隔离数据根下 projects:list 返回空 → 空态）
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByText(/No project yet/i)).toBeVisible();
});
