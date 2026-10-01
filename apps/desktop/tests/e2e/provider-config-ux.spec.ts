/**
 * T10.3 Provider 填表化 E2E：模板新建 anthropic-compatible、编辑、删除；
 * 以及校验失败人话化 / local-login 建档流（适配两步对话框）。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let fakeBinDir: string;

const FAKE_CATALOG =
  '{"models":[{"slug":"gpt-fake-1","display_name":"GPT Fake 1","visibility":"list"},' +
  '{"slug":"gpt-fake-2","display_name":"GPT Fake 2","visibility":"list"},' +
  '{"slug":"internal-hidden","display_name":"Hidden","visibility":"hide"}]}';

function seedFakeCodex(dir: string): void {
  writeFileSync(
    join(dir, "codex.cmd"),
    [
      "@echo off",
      'if "%~1"=="login" (',
      "  echo Logged in using ChatGPT",
      "  exit /b 0",
      ")",
      'if "%~1"=="debug" (',
      `  echo ${FAKE_CATALOG}`,
      "  exit /b 0",
      ")",
      "exit /b 1",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const posix = join(dir, "codex");
  writeFileSync(
    posix,
    [
      "#!/bin/sh",
      'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
      `if [ "$1" = "debug" ]; then echo '${FAKE_CATALOG}'; exit 0; fi`,
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(posix, 0o755);
}

test.beforeAll(async () => {
  fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-fakecli-"));
  seedFakeCodex(fakeBinDir);
  launched = await launchApp({ pathPrepend: fakeBinDir });
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(fakeBinDir, { recursive: true, force: true });
});

test("校验失败呈现人话化错误：友好概括 + 字段定位 + 技术详情折叠", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");

  await page.getByRole("button", { name: "New provider" }).click();
  await page.getByTestId("provider-template-openai-compatible").click();
  await page.locator("#provider-name").fill("Broken Provider");
  await page.locator("#provider-apikey").fill("sk-e2e-dummy-key");
  // 故意不填 baseUrl（兼容模板必填）
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const humanized = page.getByTestId("humanized-error");
  await expect(humanized).toBeVisible();
  await expect(humanized).toContainText("The provider configuration failed validation");
  await expect(humanized).toContainText("Base URL");

  await expect(humanized.locator("pre")).toHaveCount(0);
  await page.getByTestId("humanized-error-toggle").click();
  await expect(humanized.locator("pre")).toContainText("Provider 校验失败");

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("local-login 建档流：登录状态显示 + 本地模型枚举 + 手填入口隐藏", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");

  await page.getByRole("button", { name: "New provider" }).click();
  await page.getByTestId("provider-template-local-login").click();
  await page.locator("#provider-name").fill("Codex Login Provider");

  const section = page.getByTestId("cli-login-section");
  await expect(section).toBeVisible();
  await expect(page.locator("#provider-cli-runtime option")).toHaveText(["claude-code", "codex"]);
  await expect(page.getByTestId("cli-login-status")).toContainText("Logged in");

  await expect(page.getByRole("button", { name: "Add model" })).toHaveCount(0);

  await page.getByTestId("cli-login-list-models").click();
  await expect(page.getByText("gpt-fake-1", { exact: true })).toBeVisible();
  await expect(page.getByText("gpt-fake-2", { exact: true })).toBeVisible();
  await expect(page.getByText("internal-hidden")).toHaveCount(0);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Codex Login Provider", { exact: true })).toBeVisible();
});

test("anthropic-compatible：经模板新建、编辑、删除", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");

  await page.getByRole("button", { name: "New provider" }).click();
  await page.getByTestId("provider-template-anthropic-compatible").click();
  await page.locator("#provider-name").fill("Relay Anthropic");
  await page.locator("#provider-baseurl").fill("https://relay.example/anthropic");
  await page.locator("#provider-apikey").fill("sk-e2e-anthropic-relay");
  await page.getByRole("button", { name: "Add model" }).click();
  await page.getByPlaceholder("Model ID").fill("claude-sonnet");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Relay Anthropic", { exact: true })).toBeVisible();

  await page.getByLabel('Edit "Relay Anthropic"').click();
  await expect(page.locator("#provider-name")).toHaveValue("Relay Anthropic");
  await page.locator("#provider-name").fill("Relay Anthropic Edited");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Relay Anthropic Edited", { exact: true })).toBeVisible();

  await page.getByLabel('Delete "Relay Anthropic Edited"').click();
  await expect(page.getByText("Relay Anthropic Edited", { exact: true })).toHaveCount(0);
});
