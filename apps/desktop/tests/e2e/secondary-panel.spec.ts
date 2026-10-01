/**
 * T9.7 B 栏布局壳 + 项目快速切换器 E2E。
 *
 * 覆盖合同验收面：
 * 1. 项目列表为空时 B 栏整栏隐藏；有项目时常显；
 * 2. A/B 独立收展（按钮 + Ctrl+B / Ctrl+Shift+B 全局键位）；
 * 3. 点击项目条目 = 切换活跃项目 + 打开工作台。
 *
 * B 栏条目的可访问名是「Switch to project: <名>」（动作语义，见 ProjectSwitcher），
 * 与项目页卡片（可访问名以裸项目名开头）天然可分，选择器不撞。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let alphaDir: string;
let betaDir: string;

const ALPHA_ITEM = "Switch to project: E2E BP Alpha";
const BETA_ITEM = "Switch to project: E2E BP Beta";

test.beforeAll(async () => {
  launched = await launchApp();
  alphaDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-bp-alpha-"));
  betaDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-bp-beta-"));
});

test.afterAll(async () => {
  await launched.cleanup();
  for (const dir of [alphaDir, betaDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const panel = () => launched.page.locator('aside[aria-label="Secondary panel"]');

test("项目列表为空时 B 栏整栏隐藏；登记项目后常显且列出全部项目", async () => {
  const { page } = launched;

  // 空态：无项目 → 整栏不渲染
  await expect(page.getByRole("heading", { name: "Workbench" })).toBeVisible();
  await expect(panel()).toHaveCount(0);

  // 登记两个项目 + cli_login Provider + Worker Profile（后续落定链路用）
  await page.evaluate(
    async (dirs: readonly string[]) => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
        (window as any).ffpane.invoke(channel, req);
      const alpha = await invoke("projects:create", { name: "E2E BP Alpha", rootPath: dirs[0] });
      await invoke("projects:create", { name: "E2E BP Beta", rootPath: dirs[1] });
      const provider = await invoke("providers:create", {
        draft: {
          name: "E2E BP CLI",
          templateId: "local-login",
          models: [{ id: "m1", label: "M1", kind: "chat" }],
          defaultModelId: "m1",
          enabled: true,
        },
      });
      await invoke("profiles:create", {
        draft: {
          name: "E2E BP Worker",
          runtime: "codex",
          providerId: provider.id,
          defaultRole: "worker",
          permissionPreset: {
            readPaths: ["**"],
            writePaths: ["**"],
            shell: "allowed",
            network: false,
            dangerousOpsRequireApproval: true,
          },
        },
      });
      // 活跃项目 = Alpha（Beta 的落定事件必须在非活跃项目上也可见）
      window.localStorage.setItem(
        "ffpane.ui-state",
        JSON.stringify({ state: { activeProjectId: alpha.id }, version: 2 }),
      );
    },
    [alphaDir, betaDir],
  );
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // 有项目即常显：两个条目都在
  await expect(panel()).toBeVisible();
  await expect(panel().getByRole("button", { name: ALPHA_ITEM })).toBeVisible();
  await expect(panel().getByRole("button", { name: BETA_ITEM })).toBeVisible();
});

test("A/B 独立收展：B 收起 A 不动；Ctrl+B 收 A、Ctrl+Shift+B 展 B，各自独立", async () => {
  const { page } = launched;

  // 收起 B：项目条目消失，但 A 栏（主导航）不受影响
  await panel().getByRole("button", { name: "Collapse secondary panel" }).click();
  await expect(panel().getByRole("button", { name: ALPHA_ITEM })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();

  // Ctrl+B 收起 A 栏：A 的收起按钮变展开；B 保持收起态（独立）
  await page.keyboard.press("Control+b");
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(panel().getByRole("button", { name: "Expand secondary panel" })).toBeVisible();

  // Ctrl+Shift+B 展开 B：项目条目回来；A 仍收起（独立）
  await page.keyboard.press("Control+Shift+b");
  await expect(panel().getByRole("button", { name: ALPHA_ITEM })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

  // 还原 A 展开，供后续用例
  await page.keyboard.press("Control+b");
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
});

test("点击项目条目：一步切换活跃项目并打开工作台", async () => {
  const { page } = launched;
  await gotoRoute(page, "/projects");

  await panel().getByRole("button", { name: BETA_ITEM }).click();

  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 })
    .toBe("#/workbench");
  await expect(panel().getByRole("button", { name: BETA_ITEM })).toHaveAttribute(
    "aria-current",
    "true",
  );
});
