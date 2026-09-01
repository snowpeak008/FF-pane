/**
 * 界面语言三态（T8.1）：zh-CN / en-US / 跟随系统。
 *
 * 为什么必须是 E2E：本单要证的是「选过具体语言之后还能回到跟随系统」，而这条路径
 * 跨了三层——选择器写入 localStorage 的设置值、i18n 现问一次系统语言、界面当场重渲染。
 * 纯逻辑单测只能覆盖中间那层的解析规则。
 *
 * 注意 _launch.ts 会先把语言固定为 en-US（写 localStorage + reload），故本文件的
 * 起点是「用户已选过 English」——恰好就是这条回归要走的起点。
 */

import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

const UI_LANGUAGE_KEY = "ffpane.ui-language";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched.cleanup();
});

/** localStorage 里持久化的界面语言设置值。 */
async function savedSetting(): Promise<string | null> {
  return launched.page.evaluate((key) => window.localStorage.getItem(key), UI_LANGUAGE_KEY);
}

/** html[lang]，即当前真正生效的界面语言。 */
async function activeLanguage(): Promise<string | null> {
  return launched.page.locator("html").getAttribute("lang");
}

test("三态切换：English → 简体中文 → 跟随系统，选择与生效语言均正确", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");

  const selector = page.locator("#setting-ui-language");
  // 起点：_launch 固定为 en-US，故选择器显示的是具体语言而非「跟随系统」
  await expect(selector).toHaveValue("en-US");
  expect(await activeLanguage()).toBe("en-US");

  // 切到中文：立即生效（选择器本身的标签是自称，不随界面语言变）
  await selector.selectOption("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  expect(await savedSetting()).toBe("zh-CN");

  // 回到跟随系统——T8.1 之前这一步做不到：选择器里根本没有这一项，
  // 且 changeUiLanguage 只会写具体语言，"system" 无从被写入。
  await selector.selectOption("system");
  await expect(selector).toHaveValue("system");
  expect(await savedSetting()).toBe("system");

  // 跟随系统下的生效语言由系统语言决定，取值随跑测机器而变，
  // 故只断言它仍是一种受支持语言（而不是空、也不是 "system"）。
  const resolved = await activeLanguage();
  expect(["zh-CN", "en-US"]).toContain(resolved);
});

test("「跟随系统」经重启后仍是跟随系统（设置值持久化，不退化成具体语言）", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");
  await page.locator("#setting-ui-language").selectOption("system");
  expect(await savedSetting()).toBe("system");

  // reload 走完整初始化路径（initI18n 重新解析一次）
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await gotoRoute(page, "/settings");

  await expect(page.locator("#setting-ui-language")).toHaveValue("system");
  expect(await savedSetting()).toBe("system");
  expect(["zh-CN", "en-US"]).toContain(await activeLanguage());
});
