/**
 * T8.4 自定义角色 E2E：设置页建角色 → Profile 绑定该角色 → 删除保护。
 *
 * 保持 hermetic：只走设置页表单与 roles:* / profiles:* IPC，不触发真机 Agent 轮
 * （自定义角色跑真实会话属验收演示，归验收记录）。链路全真实：
 * 表单 → IPC → 主进程 core 校验 → storage roles.json / profiles.json 落盘 → 列表回读。
 */

import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched.cleanup();
});

test("设置页不再显示档案、自定义角色和默认权限预设", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");
  await expect(page.getByTestId("settings-configs")).toBeVisible();
  await expect(page.getByRole("button", { name: "New profile" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New role" })).toHaveCount(0);
  await expect(page.getByText("Default permission preset", { exact: false })).toHaveCount(0);
});
