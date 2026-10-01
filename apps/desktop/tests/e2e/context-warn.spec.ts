/**
 * 设置页上下文阈值：默认 70%，改 50% 后 config:get 读回。
 * 旧会话页上的估算横幅已随会话流程下线，这里只守设置项本身。
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

test("设置页阈值设置项：默认 70%，改 50% 真落盘", async () => {
  const { page } = launched;

  await gotoRoute(page, "/settings");
  const select = page.locator("#setting-context-warn-percent");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("70");

  await select.selectOption("50");
  await expect(select).toHaveValue("50");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const config = await (
          window as unknown as {
            ffpane: { invoke: (channel: string) => Promise<{ contextWarnPercent: number }> };
          }
        ).ffpane.invoke("config:get");
        return config.contextWarnPercent;
      }),
    )
    .toBe(50);
});
