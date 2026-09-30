/**
 * T10.2'：重启后布局恢复 + 退出前 flush + 渲染端 reload 后 PTY 对账。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

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

async function selectProject(page: LaunchedApp["page"], name: string): Promise<void> {
  await gotoRoute(page, "/projects");
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

/** T10.4：新建/分屏入口弹出类型对话框；确认默认 PowerShell。 */
async function confirmShellInNewWindowDialog(page: LaunchedApp["page"]): Promise<void> {
  await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
  await page.getByTestId("workbench-new-kind-shell").click();
  await page.getByTestId("workbench-new-confirm").click();
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

async function readTerminalId(page: LaunchedApp["page"], windowId: string): Promise<string> {
  const id = await page
    .locator(`[data-window-id="${windowId}"]`)
    .getByTestId("terminal-id")
    .textContent();
  const trimmed = id?.trim() ?? "";
  expect(trimmed.length).toBeGreaterThan(0);
  return trimmed;
}

test("restart restores layout tabs/split/titles and shell stays usable", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-wb-restart-"));
  let first: LaunchedApp | undefined;
  let second: LaunchedApp | undefined;
  try {
    first = await launchApp({ retainDataRoot: true });
    const { app, page, dataRoot } = first;

    await createProject(app, page, projectDir, "Restart Layout Proj");
    await selectProject(page, "Restart Layout Proj");
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await confirmShellInNewWindowDialog(page);
    await expect(page.getByTestId("workbench-window")).toHaveCount(1, { timeout: 15_000 });
    const windowA = await requireWindowId(page, 0);
    await expect
      .poll(async () => readReplayForWindow(page, windowA), { timeout: 20_000 })
      .toMatch(/\S/);

    await page.getByRole("button", { name: "Split right" }).first().click();
    await confirmShellInNewWindowDialog(page);
    await expect(page.getByTestId("workbench-window")).toHaveCount(2, { timeout: 15_000 });
    const windowB = await requireWindowId(page, 1);

    // 双击标题改名后立刻关应用（不等 400ms 防抖），覆盖退出 flush
    const titleButton = page.locator(`[data-window-id="${windowA}"] button`).first();
    await titleButton.dblclick();
    const titleInput = page.locator(`[data-window-id="${windowA}"] input`).first();
    await expect(titleInput).toBeVisible();
    await titleInput.fill("Persist Title A");
    await titleInput.press("Enter");
    await expect(page.locator(`[data-window-id="${windowA}"] button`).first()).toHaveText(
      "Persist Title A",
    );

    // 立刻关应用（验证 flush 把最后一次改名落盘）
    await first.cleanup();
    first = undefined;

    second = await launchApp({ dataRoot });
    const page2 = second.page;
    await selectProject(page2, "Restart Layout Proj");
    await gotoRoute(page2, "/workbench");
    await expect(page2.getByTestId("workbench-window")).toHaveCount(2, { timeout: 20_000 });
    await expect(page2.getByTestId("workbench-tab")).toHaveCount(1, { timeout: 10_000 });

    const restoredIds = await page2
      .getByTestId("workbench-window")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-window-id")));
    expect(restoredIds).toContain(windowA);
    expect(restoredIds).toContain(windowB);

    await expect
      .poll(
        async () => {
          const layouts = await page2.evaluate(async () => {
            // biome-ignore lint/suspicious/noExplicitAny: E2E
            return (window as any).ffpane.invoke("workbench:get-layouts");
          });
          for (const layout of Object.values(layouts) as Array<{
            windows: Record<string, { title: string }>;
          }>) {
            if (layout.windows[windowA]?.title === "Persist Title A") {
              return true;
            }
          }
          return false;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // 恢复后的 shell 可用
    await expect
      .poll(async () => readReplayForWindow(page2, windowA), { timeout: 20_000 })
      .toMatch(/\S/);
    await typeInWindow(page2, windowA, "echo RESTART_OK");
    await expect
      .poll(async () => readReplayForWindow(page2, windowA), { timeout: 20_000 })
      .toContain("RESTART_OK");
  } finally {
    if (first !== undefined) {
      await first.cleanup();
    }
    if (second !== undefined) {
      await second.cleanup();
    }
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("reload reattaches PTY without respawn", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-wb-reload-"));
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "Reload Reconcile Proj");
    await selectProject(page, "Reload Reconcile Proj");
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await confirmShellInNewWindowDialog(page);
    await expect(page.getByTestId("workbench-window")).toHaveCount(1, { timeout: 15_000 });
    const windowId = await requireWindowId(page, 0);
    await expect
      .poll(async () => readReplayForWindow(page, windowId), { timeout: 20_000 })
      .toMatch(/\S/);
    await typeInWindow(page, windowId, "echo RELOAD_MARK");
    await expect
      .poll(async () => readReplayForWindow(page, windowId), { timeout: 20_000 })
      .toContain("RELOAD_MARK");
    const terminalIdBefore = await readTerminalId(page, windowId);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await gotoRoute(page, "/workbench");
    await expect(page.getByTestId("workbench-window")).toHaveCount(1, { timeout: 20_000 });
    await expect
      .poll(async () => readReplayForWindow(page, windowId), { timeout: 20_000 })
      .toContain("RELOAD_MARK");
    const terminalIdAfter = await readTerminalId(page, windowId);
    expect(terminalIdAfter).toBe(terminalIdBefore);

    // 未重新 spawn：list 中该 windowId 仍只有一个存活 PTY
    const aliveForWindow = await page.evaluate(async (wid) => {
      // biome-ignore lint/suspicious/noExplicitAny: E2E
      const list = await (window as any).ffpane.invoke("terminal:list");
      return (
        list as Array<{ id: string; exited: boolean; metadata?: Record<string, string> }>
      ).filter((item) => !item.exited && item.metadata?.["windowId"] === wid).length;
    }, windowId);
    expect(aliveForWindow).toBe(1);
  } finally {
    await launched.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  }
});
