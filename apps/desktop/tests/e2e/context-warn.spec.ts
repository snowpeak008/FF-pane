/**
 * 设置页不再显示上下文阈值。字段仍在 config.json，读入不能报错。
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

test("设置页没有上下文阈值，config:get 仍能读出该字段", async () => {
  const { page } = launched;

  await gotoRoute(page, "/settings");
  await expect(page.locator("#setting-context-warn-percent")).toHaveCount(0);
  await expect(page.locator("#setting-output-language")).toBeVisible();

  const percent = await page.evaluate(async () => {
    const config = await (
      window as unknown as {
        ffpane: { invoke: (channel: string) => Promise<{ contextWarnPercent: number }> };
      }
    ).ffpane.invoke("config:get");
    return config.contextWarnPercent;
  });
  expect(percent).toBe(70);
});
