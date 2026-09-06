/**
 * T9.2 配置体验收口 E2E：
 * 1. 报错人话化（①）：造一个校验失败（openai_compatible 缺 baseUrl）→ 断言
 *    对话框呈现友好概括 + 字段定位 + 可展开的「技术详情」折叠（原文仍可见）；
 * 2. cli_login 建档流（②③）：假 codex CLI 前置 PATH → 选 cli_login 类型 →
 *    登录状态显示「已登录」→ 点「读取本地模型」拉到假目录 → 手填入口隐藏、
 *    枚举结果进列表。
 *
 * 假 CLI 路径照 task-parallel.spec 款式（launch helper 的 pathPrepend）：
 * Windows 走 .cmd 垫片、POSIX 走 sh 脚本，按第一个参数分流 login status /
 * debug models 两个探测命令，全程 hermetic 零联网。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let fakeBinDir: string;

/** 假 codex 的模型目录（visibility=hide 条目应被过滤，真机形状的最小子集）。 */
const FAKE_CATALOG =
  '{"models":[{"slug":"gpt-fake-1","display_name":"GPT Fake 1","visibility":"list"},' +
  '{"slug":"gpt-fake-2","display_name":"GPT Fake 2","visibility":"list"},' +
  '{"slug":"internal-hidden","display_name":"Hidden","visibility":"hide"}]}';

/**
 * 假 codex：`codex login status` → exit 0（已登录判定）；`codex debug models` →
 * 输出 JSON 目录。其余参数 exit 1（本 spec 不该触发别的调用形态）。
 */
function seedFakeCodex(dir: string): void {
  writeFileSync(
    join(dir, "codex.cmd"),
    [
      "@echo off",
      // %~1 剥引号：探测执行器经 cmd.exe /c 转发时逐参数加引号（executor.ts quoteForCmd）
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
  // openai_compatible 缺 baseUrl：表单能提交（只有名称是 UI 必填），落盘校验必拒
  await page.locator("#provider-name").fill("Broken Provider");
  await page.locator("#provider-apikey").fill("sk-e2e-dummy-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // 翻译层命中 provider-validation：友好概括 + 字段行（Base URL），非整串技术原文
  const humanized = page.getByTestId("humanized-error");
  await expect(humanized).toBeVisible();
  await expect(humanized).toContainText("The provider configuration failed validation");
  await expect(humanized).toContainText("Base URL");

  // 「技术详情」默认折叠，点开可见原始 message（原文可见可复制的纪律不破）
  await expect(humanized.locator("pre")).toHaveCount(0);
  await page.getByTestId("humanized-error-toggle").click();
  await expect(humanized.locator("pre")).toContainText("Provider 校验失败");

  // 收尾：取消对话框，不留脏状态
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("cli_login 建档流：登录状态显示 + 本地模型枚举 + 手填入口隐藏", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");

  await page.getByRole("button", { name: "New provider" }).click();
  await page.locator("#provider-name").fill("Codex Login Provider");
  await page.locator("#provider-type").selectOption("cli_login");

  // cli_login 区出现；默认选中 codex → 探测假 CLI → 已登录
  const section = page.getByTestId("cli-login-section");
  await expect(section).toBeVisible();
  await expect(page.getByTestId("cli-login-status")).toContainText("Logged in");

  // 手填模型入口对 cli_login 隐藏（禁手填是合同硬要求）
  await expect(page.getByRole("button", { name: "Add model" })).toHaveCount(0);

  // 读取本地模型：假目录两条 list 条目进列表，hide 条目被过滤
  await page.getByTestId("cli-login-list-models").click();
  await expect(page.getByText("gpt-fake-1", { exact: true })).toBeVisible();
  await expect(page.getByText("gpt-fake-2", { exact: true })).toBeVisible();
  await expect(page.getByText("internal-hidden")).toHaveCount(0);

  // 保存真落盘：列表出现该 Provider 行
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Codex Login Provider", { exact: true })).toBeVisible();
});
