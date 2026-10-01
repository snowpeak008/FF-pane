/**
 * T9.5 角色模板预填 E2E：新建出现 #role-template；选一套后 prompt 非空；
 * 编辑既有角色该下拉不出现。
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

test("自定义角色入口不再出现在设置页", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");
  await expect(page.getByRole("button", { name: "New role" })).toHaveCount(0);
  await expect(page.locator("#role-template")).toHaveCount(0);
});
