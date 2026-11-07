/**
 * T11.9 设置页分组：左边一列分组，右边一次只显示一组；记得上次那一组；`?group=` 直达。
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

test("一次只显示一组，切到别的页面再回来还是上次那一组", async () => {
  const { page } = launched;

  await gotoRoute(page, "/settings");
  await expect(page.getByTestId("settings-panel-general")).toBeVisible();
  await expect(page.locator("#setting-ui-language")).toBeVisible();
  await expect(page.getByTestId("settings-configs")).toHaveCount(0);

  await page.getByTestId("settings-group-models").click();
  await expect(page.getByTestId("settings-group-models")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("settings-configs")).toBeVisible();
  await expect(page.locator("#setting-ui-language")).toHaveCount(0);

  await gotoRoute(page, "/projects");
  await gotoRoute(page, "/settings");
  await expect(page.getByTestId("settings-panel-models")).toBeVisible();

  await gotoRoute(page, "/settings?group=tools");
  await expect(page.getByTestId("settings-panel-tools")).toBeVisible();
  await expect(page.getByTestId("settings-configs")).toHaveCount(0);

  await gotoRoute(page, "/settings?group=workbench");
  await expect(page.getByTestId("setting-workbench-role-manual")).toBeVisible();
});
