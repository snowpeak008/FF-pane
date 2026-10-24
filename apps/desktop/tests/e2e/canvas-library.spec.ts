/**
 * T11.0：画板是项目图库。界面上标「不要」、删进回收站、恢复、处理 AI 的删图申请、彻底删除。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

// 1×1 透明 PNG。
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function seedCanvas(root: string): void {
  const dir = join(root, ".ffpane", "canvas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.png"), PNG);
  writeFileSync(join(dir, "b.png"), PNG);
  const at = new Date().toISOString();
  writeFileSync(
    join(dir, "board.json"),
    `${JSON.stringify({
      v: 1,
      pages: [
        {
          id: "page-1",
          title: "1",
          rows: [
            { id: "row-a", versions: [{ path: ".ffpane/canvas/a.png", addedAt: at }] },
            { id: "row-b", versions: [{ path: ".ffpane/canvas/b.png", addedAt: at }] },
          ],
        },
      ],
      annotations: {},
      activePageId: "page-1",
      notes: {
        ".ffpane/canvas/b.png": {
          deleteRequest: { by: "Worker 1", reason: "draft is wrong", at },
        },
      },
    })}\n`,
  );
}

async function createProject(launched: LaunchedApp, dir: string, name: string): Promise<void> {
  const { app, page } = launched;
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
}

test("画板：标不要、删进回收站再恢复、处理删图申请、彻底删除", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-canvas-"));
  seedCanvas(projectDir);
  const canvasDir = join(projectDir, ".ffpane", "canvas");
  const launched = await launchApp();
  try {
    const { page } = launched;
    await createProject(launched, projectDir, "E2E Canvas Library");
    await page.getByRole("button", { name: /^E2E Canvas Library/ }).click();
    await gotoRoute(page, "/workbench");
    await page.getByTestId("open-canvas").click();
    const thumb = (name: string) => page.locator(`button[title*="${name}"]`);
    await expect(thumb("a.png")).toBeVisible();
    await expect(thumb("b.png").getByTestId("canvas-image-flag")).toHaveText("Delete requested");

    // 标「不要」：缩略图上有标记，图还在。
    await thumb("a.png").click();
    await page.getByTestId("canvas-mark-rejected").click();
    await expect(thumb("a.png").getByTestId("canvas-image-flag")).toHaveText("Unwanted");
    expect(existsSync(join(canvasDir, "a.png"))).toBe(true);

    // 删进回收站，再恢复。
    await page.getByTestId("canvas-trash-image").click();
    await expect(thumb("a.png")).toHaveCount(0);
    expect(existsSync(join(canvasDir, "a.png"))).toBe(false);
    await expect(page.getByTestId("canvas-trash-toggle")).toHaveText("Recycle bin (1)");
    await page.getByTestId("canvas-trash-toggle").click();
    await page.getByTestId("canvas-trash").getByRole("button", { name: "Restore" }).click();
    await expect(thumb("a.png")).toBeVisible();
    expect(existsSync(join(canvasDir, "a.png"))).toBe(true);
    await expect(page.getByTestId("canvas-trash-toggle")).toHaveText("Recycle bin (0)");

    // AI 的删图申请：保留就撤掉申请；再挂一次时同意，图进回收站。
    await thumb("b.png").click();
    await expect(page.getByTestId("canvas-delete-request")).toContainText("Worker 1");
    await page.getByTestId("canvas-delete-request").getByRole("button", { name: "Keep" }).click();
    await expect(page.getByTestId("canvas-delete-request")).toHaveCount(0);
    expect(existsSync(join(canvasDir, "b.png"))).toBe(true);

    // 彻底删除要二次确认。
    await page.getByTestId("canvas-trash-image").click();
    await expect(page.getByTestId("canvas-trash-toggle")).toHaveText("Recycle bin (1)");
    await page
      .getByTestId("canvas-trash")
      .getByRole("button", { name: "Delete permanently" })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByTestId("canvas-trash-toggle")).toHaveText("Recycle bin (0)");
    expect(existsSync(join(canvasDir, "b.png"))).toBe(false);
  } finally {
    await launched.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  }
});
