/**
 * T9.3 ① 列表新鲜度：Profile 编辑器对话框常驻挂载，providers:list / roles:list
 * 只在挂载时拉一次——修复前，设置页加载后新建的 Provider / 自定义角色不会出现在
 * Profile 编辑器下拉里（跨区无失效通知）。本 spec 钉住修复后的行为：
 * 建 Provider → 建自定义角色 → 打开 Profile 编辑器 → 两者都在下拉中。
 *
 * 顺序刻意让 Profile 编辑器的首次挂载查询发生在建档之前（进设置页那一刻
 * 对话框即挂载、清单已拉过一次且为空），修复缺席时本 spec 必红。
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

test("设置页加载后新建的 Provider 与角色出现在 Profile 编辑器下拉", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");

  // 进页即挂载 ProfileEditorDialog，其 providers:list / roles:list 已拉过（空集）。
  // 先建 Provider（走 ProvidersSection 自己的对话框与 hook 实例）
  await page.getByRole("button", { name: "New provider" }).click();
  await page.locator("#provider-name").fill("Fresh Provider");
  await page.locator("#provider-baseurl").fill("https://api.fresh.example/v1");
  await page.locator("#provider-apikey").fill("sk-e2e-dummy-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Fresh Provider", { exact: true })).toBeVisible();

  // 再建自定义角色（RolesSection 同款常驻挂载对话框，① 同类排查项）
  await page.getByRole("button", { name: "New role" }).click();
  await page.locator("#role-name").fill("Fresh Role");
  await page.locator("#role-prompt").fill("You review naming conventions only.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Fresh Role", { exact: true })).toBeVisible();

  // 打开 Profile 编辑器：修复让打开时 refetch，两个新档案必须已在下拉里
  await page.getByRole("button", { name: "New profile" }).click();
  await expect(page.locator("#profile-provider option", { hasText: "Fresh Provider" })).toHaveCount(
    1,
  );
  await expect(page.locator("#profile-role option", { hasText: "Fresh Role" })).toHaveCount(1);

  // 收尾：取消对话框，不留脏状态
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});
