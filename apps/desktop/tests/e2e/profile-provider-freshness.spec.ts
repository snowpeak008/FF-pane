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

test("来源页还在，档案和自定义角色入口不再出现", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");
  await expect(page.getByRole("button", { name: "New provider" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New profile" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New role" })).toHaveCount(0);
  await expect(page.getByTestId("settings-configs")).toBeVisible();
});
