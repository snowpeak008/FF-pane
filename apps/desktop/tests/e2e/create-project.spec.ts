/**
 * 冒烟 2：新建项目（§13 清单 #1）。
 *
 * 原生目录对话框（dialog:pick-directory → dialog.showOpenDialog）无法经页面驱动，
 * 故用 app.evaluate 在主进程打桩返回预置临时目录（零生产代码改动）。
 * 断言：项目卡片出现 + 目标目录下生成 .workbench/ 结构（projects:create → initProjectLayout）。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let projectDir: string;

test.beforeAll(async () => {
  launched = await launchApp();
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-project-"));
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
});

test("选目录 → 命名 → 创建，项目卡片出现且 .workbench 生成", async () => {
  const { app, page } = launched;

  // 主进程打桩：目录选择器直接返回预置临时目录
  await app.evaluate(async ({ dialog }, dir) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 打桩覆盖原生 API，仅测试期生效
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, projectDir);

  await gotoRoute(page, "/projects");

  // 空态主操作打开新建对话框
  await page.getByRole("button", { name: "New project" }).click();

  // 选目录（走打桩）→ 路径回填
  await page.getByRole("button", { name: /Choose directory/i }).click();
  await expect(page.locator("#create-project-path")).toHaveValue(projectDir);

  // 覆盖名称为确定值，便于断言
  const projectName = "E2E Smoke Project";
  await page.locator("#create-project-name").fill(projectName);

  await page.getByRole("button", { name: "Create", exact: true }).click();

  // 卡片出现（列表刷新）。卡片按钮的可访问名以项目名开头——锚定开头即排除
  // 同名成功 toast（div）与「Remove "…"」按钮。
  await expect(page.getByRole("button", { name: new RegExp(`^${projectName}`) })).toBeVisible();

  // 磁盘副作用：.workbench 结构落地
  await expect
    .poll(() => existsSync(join(projectDir, ".workbench")), { timeout: 10_000 })
    .toBe(true);
});
