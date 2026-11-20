/**
 * 工作台窗口标题栏的 E2E helper（§9 界面精简）。
 * 标题栏只剩图标、状态点、窗口名和要用户动手的小标：
 * 详情（来源 / 模型、谁开的、技能…）在窗口名的悬浮提示里，
 * 会话、权限、上线下线、加窗口在「⋯」菜单里。两者都挂在 body 上，不在窗口元素里面。
 */

import { expect, type Locator, type Page } from "@playwright/test";

/** 悬浮在窗口名上，等详情提示出来。 */
export async function windowDetails(page: Page, pane: Locator): Promise<Locator> {
  await pane.getByTestId("workbench-window-title").hover();
  const details = page.getByTestId("workbench-window-details");
  await expect(details).toBeVisible();
  return details;
}

/** 打开窗口的「⋯」菜单。 */
export async function openWindowMenu(page: Page, pane: Locator): Promise<Locator> {
  await pane.getByTestId("workbench-window-menu").click();
  const menu = page.getByTestId("workbench-window-menu-content");
  await expect(menu).toBeVisible();
  return menu;
}

/** 收起菜单 / 提示。 */
export async function dismissOverlays(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}
