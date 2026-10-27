/**
 * T11.0d：画板去重、放图不重复加行、合并前留备份；画板图片地址。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CanvasBoard, dedupeCanvasBoard, defaultCanvasBoard } from "@ff-pane/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANVAS_BOARD_DEDUPE_BACKUP,
  ingestCanvasDirectoryFile,
  loadCanvasBoard,
  placeImageOnBoard,
  updateCanvasAnnotations,
} from "../src/main/workbench/canvas-files";
import { canvasImageUrl, parseCanvasImageUrl } from "../src/shared/canvas-image-url";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const roots: string[] = [];

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-dedupe-"));
  roots.push(dir);
  mkdirSync(join(dir, ".ffpane", "canvas"), { recursive: true });
  return dir;
}

function image(root: string, name: string): string {
  writeFileSync(join(root, ".ffpane", "canvas", name), PNG);
  return `.ffpane/canvas/${name}`;
}

function paths(board: CanvasBoard): string[][] {
  return board.pages.flatMap((page) => page.rows.map((row) => row.versions.map((v) => v.path)));
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dedupeCanvasBoard", () => {
  it("没有重复时原样返回", () => {
    const board = defaultCanvasBoard();
    const result = dedupeCanvasBoard(board);
    expect(result.removed).toBe(0);
    expect(result.board).toBe(board);
  });

  it("留第一次出现的，后面重复的去掉，空行去掉", () => {
    const board: CanvasBoard = {
      ...defaultCanvasBoard(),
      pages: [
        {
          id: "page-1",
          title: "1",
          rows: [
            { id: "r1", versions: [{ path: "a", addedAt: "1" }] },
            { id: "r2", versions: [{ path: "a", addedAt: "2" }] },
            {
              id: "r3",
              versions: [
                { path: "b", addedAt: "3" },
                { path: "a", addedAt: "4" },
              ],
            },
          ],
        },
        { id: "page-2", title: "2", rows: [{ id: "r4", versions: [{ path: "b", addedAt: "5" }] }] },
      ],
    };
    const result = dedupeCanvasBoard(board);
    expect(result.removed).toBe(3);
    expect(paths(result.board)).toEqual([["a"], ["b"]]);
    expect(result.board.pages[1]?.rows).toEqual([]);
  });
});

describe("放图不重复", () => {
  it("目录监听先收进来，再放同一张图：仍只有一行", async () => {
    const root = project();
    const rel = image(root, "gen-1.png");
    await ingestCanvasDirectoryFile(root, "gen-1.png");
    const placed = await placeImageOnBoard(root, rel, {});
    expect(placed.ok).toBe(true);
    await placeImageOnBoard(root, rel, {});
    expect(paths(await loadCanvasBoard(root))).toEqual([[rel]]);
  });

  it("只有真新加的才算新图：监听先收进来，放图就不算；反过来也一样", async () => {
    const root = project();
    const first = image(root, "w1.png");
    expect(await ingestCanvasDirectoryFile(root, "w1.png")).toBe(true);
    const again = await placeImageOnBoard(root, first, {});
    expect(again.ok && again.added).toBe(false);

    const second = image(root, "w2.png");
    const placed = await placeImageOnBoard(root, second, {});
    expect(placed.ok && placed.added).toBe(true);
    expect(await ingestCanvasDirectoryFile(root, "w2.png")).toBe(false);
  });

  it("要挂到别的行当新版本：从原来那行挪过去，标注留着", async () => {
    const root = project();
    const first = image(root, "a.png");
    const second = image(root, "b.png");
    await placeImageOnBoard(root, first, { rowId: "row-a" });
    await placeImageOnBoard(root, second, {});
    await updateCanvasAnnotations(root, second, [
      { id: "x", kind: "label", x: 0, y: 0, w: 0, h: 0, color: "#f00", text: "改这里" },
    ]);
    await placeImageOnBoard(root, second, { rowId: "row-a", asNewVersion: true });
    const board = await loadCanvasBoard(root);
    expect(paths(board)).toEqual([[first, second]]);
    expect(board.annotations[second]?.[0]?.text).toBe("改这里");
  });
});

describe("读到重复行", () => {
  it("内存里合并，原文件先备份一份，下一次写画板时写回合并后的", async () => {
    const root = project();
    const rel = image(root, "dup.png");
    const other = image(root, "other.png");
    const boardPath = join(root, ".ffpane", "canvas", "board.json");
    const original = `${JSON.stringify({
      v: 1,
      pages: [
        {
          id: "page-1",
          title: "1",
          rows: [
            { id: "r1", versions: [{ path: rel, addedAt: "1" }] },
            { id: "r2", versions: [{ path: rel, addedAt: "2" }] },
          ],
        },
      ],
      annotations: {},
      activePageId: "page-1",
    })}\n`;
    writeFileSync(boardPath, original);

    expect(paths(await loadCanvasBoard(root))).toEqual([[rel]]);
    const backup = join(root, ".ffpane", "canvas", CANVAS_BOARD_DEDUPE_BACKUP);
    expect(readFileSync(backup, "utf8")).toBe(original);
    expect(readFileSync(boardPath, "utf8")).toBe(original);

    await placeImageOnBoard(root, other, {});
    const written = JSON.parse(readFileSync(boardPath, "utf8")) as CanvasBoard;
    expect(paths(written)).toEqual([[rel], [other]]);

    // 备份只留第一次的，不覆盖。
    writeFileSync(boardPath, original.replace('"2"', '"3"'));
    await loadCanvasBoard(root);
    expect(readFileSync(backup, "utf8")).toBe(original);
    expect(existsSync(backup)).toBe(true);
  });
});

describe("画板图片地址", () => {
  it("来回不变，中文和空格也行", () => {
    const url = canvasImageUrl(
      "project-1",
      ".ffpane/canvas/岛 屿#1.png",
      "thumb",
      "2026-10-27T00:00:00Z",
    );
    expect(url.startsWith("ffpane-canvas://image/?")).toBe(true);
    expect(parseCanvasImageUrl(url)).toEqual({
      projectId: "project-1",
      relativePath: ".ffpane/canvas/岛 屿#1.png",
      size: "thumb",
    });
  });

  it("不认识的地址不接", () => {
    expect(
      parseCanvasImageUrl("ffpane-canvas://image/?project=p&path=a.png&size=huge"),
    ).toBeUndefined();
    expect(parseCanvasImageUrl("https://image/?project=p&path=a.png&size=full")).toBeUndefined();
    expect(
      parseCanvasImageUrl("ffpane-canvas://other/?project=p&path=a.png&size=full"),
    ).toBeUndefined();
    expect(parseCanvasImageUrl("ffpane-canvas://image/?path=a.png&size=full")).toBeUndefined();
    expect(parseCanvasImageUrl("not a url")).toBeUndefined();
  });
});
