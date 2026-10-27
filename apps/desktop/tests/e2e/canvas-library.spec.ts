/**
 * T11.0：画板是项目图库。界面上标「不要」、删进回收站、恢复、处理 AI 的删图申请、彻底删除。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
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

/** 生成一张 w×h 的不透明 PNG（左红右蓝），够大才看得出缩略图。 */
function makePng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of bytes) {
      c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = x < width / 2 ? 220 : 30;
      row[3 + x * 3] = x < width / 2 ? 30 : 220;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("画板图片走 ffpane-canvas://：缩略图、大图、带标记预览；新图只在按钮上记数（T11.0d）", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-canvas-img-"));
  const canvasDir = join(projectDir, ".ffpane", "canvas");
  mkdirSync(canvasDir, { recursive: true });
  writeFileSync(join(canvasDir, "big.png"), makePng(600, 300));
  writeFileSync(
    join(canvasDir, "board.json"),
    `${JSON.stringify({
      v: 1,
      pages: [
        {
          id: "page-1",
          title: "1",
          rows: [
            {
              id: "row-big",
              versions: [{ path: ".ffpane/canvas/big.png", addedAt: new Date().toISOString() }],
            },
          ],
        },
      ],
      annotations: {},
      activePageId: "page-1",
    })}\n`,
  );
  const launched = await launchApp();
  try {
    const { page } = launched;
    await createProject(launched, projectDir, "E2E Canvas Images");
    await page.getByRole("button", { name: /^E2E Canvas Images/ }).click();
    await gotoRoute(page, "/workbench");
    await page.getByTestId("open-canvas").click();

    // 缩略图：从协议取，是缩过的。
    const thumb = page.locator('button[title*="big.png"] img');
    await expect(thumb).toHaveAttribute("src", /^ffpane-canvas:\/\/image\/\?/);
    await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256);
    expect(readdirSync(join(launched.dataRoot, "cache", "canvas-thumbs")).length).toBe(1);

    // 大图：原图尺寸。
    await page.locator('button[title*="big.png"]').click();
    const full = page.locator('img[src*="size=full"]');
    await expect.poll(() => full.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(600);

    // 点一下打标签：带标记的预览要能把原图画进 canvas 导出来（跨源）。
    const box = await full.boundingBox();
    if (box === null) {
      throw new Error("viewer image has no box");
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const input = page.getByPlaceholder("Write on this bubble");
    await input.fill("make it brighter");
    await input.press("Enter");
    await expect
      .poll(() => existsSync(join(canvasDir, "revisions", "big.png.marked.png")))
      .toBe(true);

    // 关掉画板后 AI 往目录里存一张图：不弹画板，按钮上记一张新图。
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    writeFileSync(join(canvasDir, "shot.png"), makePng(40, 20));
    await expect(page.getByTestId("open-canvas")).toHaveText("Open canvas (1 new)");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByTestId("open-canvas").click();
    await expect(page.locator('button[title*="shot.png"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("open-canvas")).toHaveText("Open canvas");
  } finally {
    await launched.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  }
});
