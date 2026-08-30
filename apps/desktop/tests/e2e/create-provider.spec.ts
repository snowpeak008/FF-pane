/**
 * 冒烟 3：新建 Provider（§13 清单 #2 的 CRUD 侧）。
 *
 * 保持 hermetic：仅做 openai_compatible 的表单填写 + 保存，不触发「测试连接」
 * （真实 DeepSeek 连接验证归 docs/验收记录/M1-验收.md 手工记录，不进 E2E）。
 * 断言：Provider 行出现在列表，携带填入的 baseUrl。
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

test("填写 openai_compatible 表单 → 保存，Provider 行出现", async () => {
  const { page } = launched;

  await gotoRoute(page, "/settings");

  // Provider 区空态主操作（默认类型即 openai_compatible）
  await page.getByRole("button", { name: "New provider" }).click();

  const providerName = "E2E Provider";
  const baseUrl = "https://api.example.com/v1";
  await page.locator("#provider-name").fill(providerName);
  await page.locator("#provider-baseurl").fill(baseUrl);
  // 键入占位密钥以走密钥加密路径（尾 4 位在编辑器占位，不在列表展示）
  await page.locator("#provider-apikey").fill("sk-e2e-dummy-key");

  await page.getByRole("button", { name: "Save", exact: true }).click();

  // 列表出现该 Provider 行。exact 名称匹配行内 span，排除同名成功 toast（"Saved "…""）；
  // baseUrl 仅出现在行内，天然无歧义。
  await expect(page.getByText(providerName, { exact: true })).toBeVisible();
  await expect(page.getByText(baseUrl)).toBeVisible();
});
