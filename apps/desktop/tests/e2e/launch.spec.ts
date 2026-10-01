/**
 * 冒烟 1：应用启动（§13 清单 #1 的启动侧）。
 *
 * 断言构建产物能启动、单窗口可见、默认路由（/workbench）渲染成功，
 * 且未选项目时工作台空态出现——证明 main↔renderer 数据链路通。
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

test("应用启动并渲染默认工作台空态", async () => {
  const { app, page } = launched;

  expect(app.windows()).toHaveLength(1);

  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain("/workbench");

  await expect(page.getByRole("heading", { name: "Workbench" })).toBeVisible();
  await expect(page.getByText(/No project selected/i)).toBeVisible();
});
