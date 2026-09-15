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

test("新建角色出现模板下拉；选一套后 prompt 非空；编辑既有角色不出现", async () => {
  const { page } = launched;

  await gotoRoute(page, "/settings");

  await page.getByRole("button", { name: "New role" }).click();
  await expect(page.locator("#role-template")).toBeVisible();

  await page.locator("#role-template").selectOption("docs-writer");
  await expect(page.locator("#role-prompt")).not.toHaveValue("");

  const roleName = "E2E Template Role";
  await page.locator("#role-name").fill(roleName);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(roleName, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `Edit "${roleName}"` }).click();
  await expect(page.locator("#role-template")).toHaveCount(0);
});
