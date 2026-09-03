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

test("新建自定义角色 → 出现在列表与 Profile 角色下拉 → 绑定后拒删 → 解绑后可删", async () => {
  const { page } = launched;

  await gotoRoute(page, "/settings");

  // 1) 自定义角色区空态 → 新建角色（名称 + 角色提示词；权限预设用默认值）
  await page.getByRole("button", { name: "New role" }).click();
  const roleName = "E2E Docs Writer";
  await page.locator("#role-name").fill(roleName);
  await page.locator("#role-prompt").fill("You are a docs writer. Only touch docs/.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(roleName, { exact: true })).toBeVisible();

  // 2) 建一个 Provider（Profile 表单必填 Provider；手填一个 chat 模型供 Profile 指定）
  await page.getByRole("button", { name: "New provider" }).click();
  await page.locator("#provider-name").fill("E2E Role Provider");
  await page.locator("#provider-baseurl").fill("https://api.example.com/v1");
  await page.locator("#provider-apikey").fill("sk-e2e-dummy-key");
  await page.getByRole("button", { name: "Add model" }).click();
  await page.getByPlaceholder("Model ID").fill("e2e-chat");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("E2E Role Provider", { exact: true })).toBeVisible();

  // 3) 新建 Profile：默认角色下拉里能选到自定义角色（optgroup「Custom roles」下）；
  //    模型显式指定（Provider 未配置 defaultModel，缺省会被 core 校验拒绝）。
  //    先 reload：Profile 编辑器的 providers/roles 查询在页面挂载时发起，
  //    同页刚建的 Provider / 角色要重挂后才进下拉（现状行为，不是被测对象）。
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await gotoRoute(page, "/settings");
  await page.getByRole("button", { name: "New profile" }).click();
  await page.locator("#profile-name").fill("E2E Docs Agent");
  await page.locator("#profile-runtime").selectOption("codex");
  await page.locator("#profile-provider").selectOption({ label: "E2E Role Provider" });
  await page.locator("#profile-model").selectOption({ label: "e2e-chat" });
  await page.locator("#profile-role").selectOption({ label: roleName });
  // 预设须 ⊆ 角色预设（校验器把关）：默认预设的 writePaths 为空、shell forbidden，天然更窄
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // Profile 行出现，角色徽标显示自定义角色名（useRoleLabel 经 roles:list 解析）——
  // 此刻页面上角色名有两处：Profile 行徽标 + 角色区行，正是徽标解析生效的实证
  await expect(page.getByText("E2E Docs Agent", { exact: true })).toBeVisible();
  await expect(page.getByText(roleName, { exact: true })).toHaveCount(2);

  // 4) 删除保护：被 Profile 引用的角色拒删（toast 报错，行保留）
  await page.getByRole("button", { name: `Delete "${roleName}"` }).click();
  await expect(page.getByText("Failed to delete custom role")).toBeVisible();
  await expect(page.getByText(roleName, { exact: true }).first()).toBeVisible();

  // 5) 解绑（删除 Profile）后可删角色
  await page.getByRole("button", { name: 'Delete "E2E Docs Agent"' }).click();
  await expect(page.getByText("E2E Docs Agent", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: `Delete "${roleName}"` }).click();
  await expect(page.getByText(roleName, { exact: true })).toBeHidden();
});
