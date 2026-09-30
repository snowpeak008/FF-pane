/**
 * T10.1：工作台终端底座 E2E——打开工作台 → 输入 echo → 断言输出；切走再回来历史仍在。
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

/** 经 IPC 读主进程环形缓冲（xterm WebGL/DOM 的 innerText 不可靠）。 */
async function readReplay(page: LaunchedApp["page"]): Promise<string> {
  return page.evaluate(async () => {
    const id = document.querySelector('[data-testid="terminal-id"]')?.textContent?.trim();
    if (id === undefined || id.length === 0) {
      return "";
    }
    // biome-ignore lint/suspicious/noExplicitAny: E2E 直连 window.ffpane
    const replay = await (window as any).ffpane.invoke("terminal:get-replay", { id });
    return typeof replay?.data === "string" ? replay.data : "";
  });
}

test("工作台 PowerShell 终端可用且切页后回放历史", async () => {
  const { page } = launched;

  await gotoRoute(page, "/workbench");
  await expect(page.getByRole("heading", { name: "Workbench" })).toBeVisible();
  const host = page.getByTestId("terminal-host");
  await expect(host).toBeVisible();

  // 等 PTY create 完成（terminal-id 出现）
  await expect(page.getByTestId("terminal-id")).toBeVisible({ timeout: 15_000 });

  // 等 shell 出字（提示符），避免在未就绪时打字
  await expect.poll(async () => readReplay(page), { timeout: 20_000 }).toMatch(/\S/);

  const termTextarea = host.locator("textarea.xterm-helper-textarea");
  await expect(termTextarea).toBeAttached({ timeout: 10_000 });
  await termTextarea.click();
  await page.keyboard.type("echo ffpane-e2e");
  await page.keyboard.press("Enter");

  await expect.poll(async () => readReplay(page), { timeout: 20_000 }).toContain("ffpane-e2e");

  // 切到项目页再回来：卸载不杀进程，回放缓冲应仍在
  await gotoRoute(page, "/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await gotoRoute(page, "/workbench");
  await expect(page.getByRole("heading", { name: "Workbench" })).toBeVisible();
  await expect(page.getByTestId("terminal-host")).toBeVisible();
  await expect(page.getByTestId("terminal-id")).toBeVisible({ timeout: 15_000 });

  await expect.poll(async () => readReplay(page), { timeout: 20_000 }).toContain("ffpane-e2e");
});
