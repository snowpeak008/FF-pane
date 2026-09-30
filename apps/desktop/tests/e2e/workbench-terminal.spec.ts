/**
 * T10.2：工作台布局 E2E——两项目各开窗口、分屏、切项目保留输出、关窗折叠、上限拒绝。
 * 兼容并覆盖原 T10.1 workbench-terminal 回放断言。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let projectA: string;
let projectB: string;

test.beforeAll(async () => {
  launched = await launchApp();
  projectA = mkdtempSync(join(tmpdir(), "ffpane-e2e-wb-a-"));
  projectB = mkdtempSync(join(tmpdir(), "ffpane-e2e-wb-b-"));
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectA, { recursive: true, force: true });
  rmSync(projectB, { recursive: true, force: true });
});

async function createProject(
  app: LaunchedApp["app"],
  page: LaunchedApp["page"],
  dir: string,
  name: string,
): Promise<void> {
  await app.evaluate(async ({ dialog }, path) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 打桩
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, dir);
  await gotoRoute(page, "/projects");
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("button", { name: /Choose directory/i }).click();
  await expect(page.locator("#create-project-path")).toHaveValue(dir);
  await page.locator("#create-project-name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect.poll(() => existsSync(join(dir, ".workbench")), { timeout: 10_000 }).toBe(true);
}

/** 经项目列表卡片选中（比 B 栏更稳：不依赖次级侧栏是否展开）。 */
async function selectProject(page: LaunchedApp["page"], name: string): Promise<void> {
  await gotoRoute(page, "/projects");
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

async function readReplayForWindow(page: LaunchedApp["page"], windowId: string): Promise<string> {
  return page.evaluate(async (wid) => {
    const host = document.querySelector(`[data-window-id="${wid}"]`);
    const id = host?.querySelector('[data-testid="terminal-id"]')?.textContent?.trim();
    if (id === undefined || id.length === 0) {
      return "";
    }
    // biome-ignore lint/suspicious/noExplicitAny: E2E
    const replay = await (window as any).ffpane.invoke("terminal:get-replay", { id });
    return typeof replay?.data === "string" ? replay.data : "";
  }, windowId);
}

async function typeInWindow(
  page: LaunchedApp["page"],
  windowId: string,
  text: string,
): Promise<void> {
  const pane = page.locator(`[data-window-id="${windowId}"]`);
  await expect(pane).toBeVisible();
  await pane.click();
  const host = pane.getByTestId("terminal-host");
  const termTextarea = host.locator("textarea.xterm-helper-textarea");
  await expect(termTextarea).toBeAttached({ timeout: 10_000 });
  await termTextarea.click({ timeout: 15_000, force: true });
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function requireWindowId(page: LaunchedApp["page"], index = 0): Promise<string> {
  const id = await page.getByTestId("workbench-window").nth(index).getAttribute("data-window-id");
  expect(id).toBeTruthy();
  if (id === null) {
    throw new Error("missing window id");
  }
  return id;
}

test("multi-project split panes keep output across switches", async () => {
  const { app, page } = launched;

  await createProject(app, page, projectA, "WB Project A");
  await createProject(app, page, projectB, "WB Project B");

  await selectProject(page, "WB Project A");
  await gotoRoute(page, "/workbench");
  await expect(page.getByRole("heading", { name: "Workbench" })).toBeVisible();
  await page.getByTestId("workbench-new-tab").click();
  await expect(page.getByTestId("workbench-window")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("terminal-id")).toBeVisible({ timeout: 15_000 });
  const windowA1 = await requireWindowId(page, 0);

  await expect
    .poll(async () => readReplayForWindow(page, windowA1), { timeout: 20_000 })
    .toMatch(/\S/);
  await typeInWindow(page, windowA1, "echo MARKER_A1");
  await expect
    .poll(async () => readReplayForWindow(page, windowA1), { timeout: 20_000 })
    .toContain("MARKER_A1");

  await page.getByRole("button", { name: "Split right" }).first().click();
  await expect(page.getByTestId("workbench-window")).toHaveCount(2, { timeout: 15_000 });
  const windowA2 = await requireWindowId(page, 1);
  await expect
    .poll(async () => readReplayForWindow(page, windowA2), { timeout: 20_000 })
    .toMatch(/\S/);
  await typeInWindow(page, windowA2, "echo MARKER_A2");
  await expect
    .poll(async () => readReplayForWindow(page, windowA2), { timeout: 20_000 })
    .toContain("MARKER_A2");

  await selectProject(page, "WB Project B");
  await gotoRoute(page, "/workbench");
  await page.getByTestId("workbench-new-tab").click();
  await expect(page.getByTestId("workbench-window")).toHaveCount(1, { timeout: 15_000 });
  const windowB1 = await requireWindowId(page, 0);
  await expect
    .poll(async () => readReplayForWindow(page, windowB1), { timeout: 20_000 })
    .toMatch(/\S/);
  await typeInWindow(page, windowB1, "echo MARKER_B1");
  await expect
    .poll(async () => readReplayForWindow(page, windowB1), { timeout: 20_000 })
    .toContain("MARKER_B1");

  await page.getByRole("button", { name: "Split right" }).first().click();
  await expect(page.getByTestId("workbench-window")).toHaveCount(2, { timeout: 15_000 });
  const windowB2 = await requireWindowId(page, 1);
  await expect
    .poll(async () => readReplayForWindow(page, windowB2), { timeout: 20_000 })
    .toMatch(/\S/);
  await typeInWindow(page, windowB2, "echo MARKER_B2");
  await expect
    .poll(async () => readReplayForWindow(page, windowB2), { timeout: 20_000 })
    .toContain("MARKER_B2");

  await selectProject(page, "WB Project A");
  await gotoRoute(page, "/workbench");
  await expect(page.getByTestId("workbench-window")).toHaveCount(2, { timeout: 15_000 });
  await expect
    .poll(async () => readReplayForWindow(page, windowA1), { timeout: 20_000 })
    .toContain("MARKER_A1");
  await expect
    .poll(async () => readReplayForWindow(page, windowA2), { timeout: 20_000 })
    .toContain("MARKER_A2");

  await page
    .getByTestId("workbench-window")
    .nth(1)
    .getByRole("button", { name: "Close window" })
    .click();
  await expect(page.getByTestId("workbench-window")).toHaveCount(1, { timeout: 10_000 });

  const layoutCount = await page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E
    const layouts = await (window as any).ffpane.invoke("workbench:get-layouts");
    let n = 0;
    for (const layout of Object.values(layouts as Record<string, { windows: object }>)) {
      n += Object.keys(layout.windows).length;
    }
    return n;
  });
  await page.evaluate(async (max) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E
    await (window as any).ffpane.invoke("config:update", { maxWorkbenchWindows: max });
  }, layoutCount);

  await page.getByTestId("workbench-new-tab").click();
  await expect(page.getByText(/concurrent window limit|同时运行窗口上限/i)).toBeVisible({
    timeout: 10_000,
  });
});

test("workbench terminal survives page switch (T10.1 compat)", async () => {
  const { page } = launched;
  await selectProject(page, "WB Project A");
  await gotoRoute(page, "/workbench");
  // 上一测可能已把上限压到当前窗口数；先抬高以免空态「新建」被拒
  await page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E
    await (window as any).ffpane.invoke("config:update", { maxWorkbenchWindows: 12 });
  });
  if ((await page.getByTestId("workbench-window").count()) === 0) {
    await page.getByTestId("workbench-new-tab").click();
  }
  await expect(page.getByTestId("terminal-host").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("terminal-id").first()).toBeVisible({ timeout: 15_000 });
  const windowId = await requireWindowId(page, 0);
  await expect
    .poll(async () => readReplayForWindow(page, windowId), { timeout: 20_000 })
    .toMatch(/\S/);
  await typeInWindow(page, windowId, "echo ffpane-e2e");
  await expect
    .poll(async () => readReplayForWindow(page, windowId), { timeout: 20_000 })
    .toContain("ffpane-e2e");
  await gotoRoute(page, "/projects");
  await gotoRoute(page, "/workbench");
  await expect
    .poll(async () => readReplayForWindow(page, windowId), { timeout: 20_000 })
    .toContain("ffpane-e2e");
});
