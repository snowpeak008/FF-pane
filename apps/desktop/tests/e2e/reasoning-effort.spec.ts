/**
 * T9.4b Profile 编辑器：推理强度下拉按 Runtime 条件显示。
 *
 * 设置页新建 Profile —— 选 claude-code 或 grok-build 出现 #profile-reasoning-effort；
 * 选 gemini-cli 不出现。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let projectDir: string;

test.beforeAll(async () => {
  launched = await launchApp();
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-effort-"));

  await launched.page.evaluate(async (dir: string) => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);
    const entry = await invoke("projects:create", { name: "E2E Effort", rootPath: dir });
    await invoke("providers:create", {
      draft: {
        name: "E2E Effort CLI",
        templateId: "local-login",
        models: [{ id: "m1", label: "M1", kind: "chat" }],
        defaultModelId: "m1",
        enabled: true,
      },
    });
    window.localStorage.setItem(
      "ffpane.ui-state",
      JSON.stringify({ state: { activeProjectId: entry.id }, version: 1 }),
    );
  }, projectDir);
  await launched.page.reload();
  await launched.page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
});

test("配置编辑器给 Claude 和 Codex 思考强度，没有其它 CLI", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");
  await page.getByTestId("config-new").click();
  await expect(page.getByTestId("config-claude-effort")).toBeVisible();
  await expect(page.getByTestId("config-codex-effort")).toBeVisible();
  await expect(page.locator("#profile-runtime")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});
