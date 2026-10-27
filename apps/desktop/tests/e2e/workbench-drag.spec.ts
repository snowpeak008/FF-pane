/**
 * T11.2c：按住标题栏拖窗口——对调、移到空格、拖到「＋」开新页、拖到别的标签。
 * 全程窗口不重启：终端编号不变，之前的输出还在，还能接着打字。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let projectDir: string;

test.beforeAll(async () => {
  launched = await launchApp();
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-drag-"));
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
});

type Page = LaunchedApp["page"];

async function createProject(app: LaunchedApp["app"], page: Page, dir: string, name: string) {
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
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

async function confirmShell(page: Page): Promise<void> {
  await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
  await page.getByTestId("workbench-new-kind-shell").click();
  await page.getByTestId("workbench-new-confirm").click();
}

function pane(page: Page, windowId: string): Locator {
  return page.locator(`[data-window-id="${windowId}"]`);
}

async function terminalId(page: Page, windowId: string): Promise<string> {
  const text = await pane(page, windowId).getByTestId("terminal-id").textContent();
  return text?.trim() ?? "";
}

async function replay(page: Page, windowId: string): Promise<string> {
  return page.evaluate(async (wid) => {
    const host = document.querySelector(`[data-window-id="${wid}"]`);
    const id = host?.querySelector('[data-testid="terminal-id"]')?.textContent?.trim();
    if (id === undefined || id.length === 0) {
      return "";
    }
    // biome-ignore lint/suspicious/noExplicitAny: E2E
    const settled = await (window as any).ffpane.invoke("terminal:get-replay", { id });
    return typeof settled?.data === "string" ? settled.data : "";
  }, windowId);
}

async function typeIn(page: Page, windowId: string, text: string): Promise<void> {
  const textarea = pane(page, windowId).locator("textarea.xterm-helper-textarea");
  await expect(textarea).toBeAttached({ timeout: 10_000 });
  await expect
    .poll(() => textarea.evaluate((el) => el.getBoundingClientRect().x >= 0), { timeout: 15_000 })
    .toBe(true);
  await textarea.click({ timeout: 15_000, force: true });
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/** 按住标题栏拖到目标中间，分几步移动，松手前看目标有没有高亮。 */
async function drag(page: Page, windowId: string, target: Locator): Promise<void> {
  const header = pane(page, windowId).getByTestId("workbench-window-header");
  const from = await header.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) {
    throw new Error("missing box");
  }
  await page.mouse.move(from.x + from.width * 0.4, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

function cell(page: Page, slot: number): Locator {
  return page.locator(`[data-testid="workbench-grid-cell"][data-slot="${slot}"]`);
}

async function slotOf(page: Page, windowId: string): Promise<string | null> {
  return page
    .locator(`[data-testid="workbench-grid-cell"]:has([data-window-id="${windowId}"])`)
    .getAttribute("data-slot");
}

test("拖窗口：对调、移到空格、开新页、移到别的标签，窗口不重启", async () => {
  const { app, page } = launched;
  await createProject(app, page, projectDir, "Drag Project");
  await gotoRoute(page, "/workbench");
  await page.getByTestId("workbench-new-tab").click();
  await confirmShell(page);
  await expect(page.getByTestId("workbench-window")).toHaveCount(1, { timeout: 15_000 });
  const a = await page.getByTestId("workbench-window").first().getAttribute("data-window-id");
  if (a === null) {
    throw new Error("missing window");
  }
  await expect.poll(() => replay(page, a), { timeout: 20_000 }).toMatch(/\S/);
  await typeIn(page, a, "echo DRAG_MARK_A");
  await expect.poll(() => replay(page, a), { timeout: 20_000 }).toContain("DRAG_MARK_A");
  const terminalA = await terminalId(page, a);

  await cell(page, 1).getByTestId("workbench-grid-empty").click();
  await confirmShell(page);
  await expect(page.getByTestId("workbench-window")).toHaveCount(2, { timeout: 15_000 });
  const b = await page.getByTestId("workbench-window").nth(1).getAttribute("data-window-id");
  if (b === null) {
    throw new Error("missing window");
  }
  await expect(pane(page, b).getByTestId("terminal-id")).toBeVisible({ timeout: 15_000 });
  const terminalB = await terminalId(page, b);
  expect(await slotOf(page, a)).toBe("0");
  expect(await slotOf(page, b)).toBe("1");

  // 1. 落到另一个窗口上：对调
  await drag(page, a, cell(page, 1));
  await expect.poll(() => slotOf(page, a)).toBe("1");
  expect(await slotOf(page, b)).toBe("0");

  // 2. 落到空格：移过去，原来那格变空
  // 右下角有提示条，挪到左下角那格（3），免得点终端时点到提示条上。
  await drag(page, a, cell(page, 3));
  await expect.poll(() => slotOf(page, a)).toBe("3");
  await expect(cell(page, 1).getByTestId("workbench-grid-empty")).toBeVisible();

  // 不重启：编号不变，之前的输出还在，还能打字
  await expect(pane(page, a).getByTestId("terminal-id")).toHaveText(terminalA, {
    timeout: 15_000,
  });
  expect(await replay(page, a)).toContain("DRAG_MARK_A");
  await typeIn(page, a, "echo DRAG_MARK_A2");
  await expect.poll(() => replay(page, a), { timeout: 20_000 }).toContain("DRAG_MARK_A2");

  // 3. 拖到「＋」：开新页，停在当前页
  await drag(page, b, page.getByTestId("workbench-new-tab"));
  await expect(page.getByTestId("workbench-tab")).toHaveCount(2);
  await expect(page.getByTestId("workbench-window")).toHaveCount(1);
  await expect(pane(page, a)).toBeVisible();

  // 4. 拖到别的标签：这一页空了就去掉，跟着窗口到那页
  const secondTab = page.locator('[data-drop="tab"]').nth(1);
  await drag(page, a, secondTab);
  await expect(page.getByTestId("workbench-tab")).toHaveCount(1);
  await expect(page.getByTestId("workbench-window")).toHaveCount(2);
  expect(await slotOf(page, b)).toBe("0");
  expect(await slotOf(page, a)).toBe("1");
  await expect(pane(page, a).getByTestId("terminal-id")).toHaveText(terminalA, {
    timeout: 15_000,
  });
  await expect(pane(page, b).getByTestId("terminal-id")).toHaveText(terminalB, {
    timeout: 15_000,
  });

  // 落盘的布局也是这样
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        const layouts = await (window as any).ffpane.invoke("workbench:get-layouts");
        const layout = Object.values(layouts)[0] as { tabs: { slots: unknown[] }[] } | undefined;
        return JSON.stringify(layout?.tabs.map((tab) => tab.slots.slice(0, 2)));
      }),
    )
    .toBe(JSON.stringify([[b, a]]));
});
