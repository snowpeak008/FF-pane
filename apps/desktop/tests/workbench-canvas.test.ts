/**
 * T10.21：画板 board 排布、路径安全、移除不删文件、标注不改原图像素。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activePage,
  addImageAsNewRow,
  appendVersionToRow,
  defaultCanvasBoard,
} from "@ff-pane/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  canvasImageSha256,
  describeCanvasRevision,
  ingestCanvasDirectoryFile,
  lexicalCanvasPath,
  loadCanvasBoard,
  placeImageOnBoard,
  removeFromCanvasBoard,
  saveCanvasBoard,
  updateCanvasAnnotations,
  writeCanvasMarkedPreview,
} from "../src/main/workbench/canvas-files";
import { readRasterSize } from "../src/main/workbench/canvas-revision";
import {
  draggedImagePoint,
  fitImageView,
  hitLabelId,
  wheelScaleFactor,
  zoomAtPoint,
} from "../src/renderer/src/pages/workbench/canvas-view";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-canvas-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeCanvasImage(root: string, name: string, bytes: Buffer): string {
  const dir = join(root, ".ffpane", "canvas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
  return `.ffpane/canvas/${name}`;
}

describe("canvas board layout", () => {
  it("不同图竖向成行", () => {
    let board = defaultCanvasBoard();
    board = addImageAsNewRow(board, ".ffpane/canvas/a.png", "row-a", "t1");
    board = addImageAsNewRow(board, ".ffpane/canvas/b.png", "row-b", "t2");
    const page = activePage(board);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]?.versions[0]?.path).toBe(".ffpane/canvas/a.png");
    expect(page.rows[1]?.versions[0]?.path).toBe(".ffpane/canvas/b.png");
  });

  it("同一张图新版本横向追加", () => {
    let board = defaultCanvasBoard();
    board = addImageAsNewRow(board, ".ffpane/canvas/a-v1.png", "row-a", "t1");
    board = appendVersionToRow(board, "row-a", ".ffpane/canvas/a-v2.png", "t2");
    const versions = activePage(board).rows[0]?.versions ?? [];
    expect(versions.map((item) => item.path)).toEqual([
      ".ffpane/canvas/a-v1.png",
      ".ffpane/canvas/a-v2.png",
    ]);
  });
});

describe("canvas files on disk", () => {
  it("从画板拿掉后文件还在", async () => {
    const root = tempDir();
    const rel = writeCanvasImage(root, "keep.png", Buffer.from("png-bytes"));
    await placeImageOnBoard(root, rel, {});
    const removed = await removeFromCanvasBoard(root, rel);
    expect(removed.ok).toBe(true);
    expect(existsSync(join(root, ".ffpane", "canvas", "keep.png"))).toBe(true);
    const board = await loadCanvasBoard(root);
    expect(activePage(board).rows).toHaveLength(0);
  });

  it("路径逃出项目目录被拒", () => {
    const root = "D:/proj";
    expect(lexicalCanvasPath(root, "../outside.png").ok).toBe(false);
    expect(lexicalCanvasPath(root, ".ffpane/../secret.png").ok).toBe(false);
    expect(lexicalCanvasPath(root, "C:/Windows/notepad.exe").ok).toBe(false);
  });

  it("标注不改原文件字节", async () => {
    const root = tempDir();
    const bytes = Buffer.from("original-image-bytes");
    const rel = writeCanvasImage(root, "pic.png", bytes);
    const before = createHash("sha256").update(bytes).digest("hex");
    await placeImageOnBoard(root, rel, {});
    await updateCanvasAnnotations(root, rel, [
      {
        id: "a1",
        kind: "rect",
        x: 1,
        y: 2,
        w: 10,
        h: 10,
        color: "#ff0000",
        label: "改这里",
      },
    ]);
    const afterDisk = createHash("sha256")
      .update(readFileSync(join(root, ".ffpane", "canvas", "pic.png")))
      .digest("hex");
    expect(afterDisk).toBe(before);
    const digest = await canvasImageSha256(root, rel);
    expect(digest.ok).toBe(true);
    if (digest.ok) {
      expect(digest.digest).toBe(before);
    }
    const board = await loadCanvasBoard(root);
    expect(board.annotations[rel]?.[0]?.label).toBe("改这里");
    const revisionPath = join(root, ".ffpane", "canvas", "revisions", "pic.png.revision.json");
    const revision = JSON.parse(readFileSync(revisionPath, "utf8")) as {
      image: string;
      marks: { text?: string }[];
    };
    expect(revision.image).toBe(rel);
    expect(revision.marks[0]?.text).toBe("改这里");
    await saveCanvasBoard(root, board);
    const afterSave = createHash("sha256")
      .update(readFileSync(join(root, ".ffpane", "canvas", "pic.png")))
      .digest("hex");
    expect(afterSave).toBe(before);
  });

  it("文字要求和带标记预览写在项目里，清掉标注后一起删", async () => {
    const root = tempDir();
    const bytes = pngSizeHeader(8, 4);
    const rel = writeCanvasImage(root, "shot.png", bytes);
    await placeImageOnBoard(root, rel, {});
    await updateCanvasAnnotations(root, rel, [
      {
        id: "b1",
        kind: "label",
        x: 2,
        y: 1,
        w: 0,
        h: 0,
        color: "#ef4444",
        text: "太阳再大",
      },
    ]);
    const revisionPath = join(root, ".ffpane", "canvas", "revisions", "shot.png.revision.json");
    const revision = JSON.parse(readFileSync(revisionPath, "utf8")) as {
      purpose: string;
      imageWidth: number;
      marks: { number?: number; text?: string; nx?: number; ny?: number }[];
      markedImage: string;
    };
    expect(revision.purpose).toContain("文字");
    expect((revision as { imageTag?: string }).imageTag).toBe(
      "项目内图片 shot.png .ffpane/canvas/shot.png",
    );
    expect(revision.purpose).toContain("markedImage");
    expect(revision.imageWidth).toBe(8);
    expect(revision.marks[0]).toMatchObject({ number: 1, text: "太阳再大", nx: 0.25, ny: 0.25 });
    const marked = await writeCanvasMarkedPreview(root, rel, bytes.toString("base64"));
    expect(marked.ok).toBe(true);
    if (marked.ok) {
      expect(marked.relativePath).toBe(revision.markedImage);
    }
    expect(readFileSync(join(root, ".ffpane", "canvas", "shot.png")).equals(bytes)).toBe(true);
    const described = await describeCanvasRevision(root, rel);
    expect(described?.markedImageReady).toBe(true);
    expect(described?.marks[0]?.text).toBe("太阳再大");
    await updateCanvasAnnotations(root, rel, []);
    expect(existsSync(revisionPath)).toBe(false);
    expect(existsSync(join(root, ".ffpane", "canvas", "revisions", "shot.png.marked.png"))).toBe(
      false,
    );
    expect(readFileSync(join(root, ".ffpane", "canvas", "shot.png")).equals(bytes)).toBe(true);
  });

  it("预览图不会被收成新的一行，也不能当成原图打开", async () => {
    const root = tempDir();
    writeCanvasImage(root, "real.png", pngSizeHeader(1, 1));
    mkdirSync(join(root, ".ffpane", "canvas", "revisions"), { recursive: true });
    writeFileSync(
      join(root, ".ffpane", "canvas", "revisions", "real.png.marked.png"),
      pngSizeHeader(1, 1),
    );
    await ingestCanvasDirectoryFile(root, "real.png.marked.png");
    await ingestCanvasDirectoryFile(root, "revisions/real.png.marked.png");
    await ingestCanvasDirectoryFile(root, "real.png");
    const board = await loadCanvasBoard(root);
    expect(activePage(board).rows.map((row) => row.versions[0]?.path)).toEqual([
      ".ffpane/canvas/real.png",
    ]);
    expect(lexicalCanvasPath(root, ".ffpane/canvas/revisions/real.png.marked.png").ok).toBe(false);
    expect(readRasterSize(jpegWithSize(12, 9))).toEqual({ width: 12, height: 9 });
  });
});

describe("canvas view", () => {
  it("小图按原大居中，大图缩进画面", () => {
    expect(fitImageView(800, 600, 400, 200)).toEqual({ scale: 1, x: 200, y: 200 });
    const fitted = fitImageView(800, 600, 1600, 1200);
    expect(fitted?.scale).toBeLessThan(1);
    expect(fitted?.x).toBeGreaterThan(0);
    expect(fitted?.y).toBeGreaterThan(0);
  });

  it("滚轮缩放后光标下的点不动", () => {
    const next = zoomAtPoint({ scale: 1, x: 0, y: 0 }, 100, 80, 2);
    expect(next).toEqual({ scale: 2, x: -100, y: -80 });
    expect(wheelScaleFactor(100)).toBeLessThan(1);
    expect(wheelScaleFactor(-100)).toBeGreaterThan(1);
  });

  it("拖气泡按缩放换算，点选按屏幕距离", () => {
    expect(draggedImagePoint(10, 10, 0, 0, 20, 0, 2, 100, 100)).toEqual({ x: 20, y: 10 });
    const view = { scale: 1, x: 0, y: 0 };
    const items = [{ id: "a", kind: "label", x: 10, y: 10, text: "字" }];
    expect(hitLabelId(items, view, 10, 10)).toBe("a");
    expect(hitLabelId(items, view, 40, 10)).toBe("a");
    expect(hitLabelId(items, view, 40, 40)).toBeUndefined();
  });
});

function pngSizeHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpegWithSize(width: number, height: number): Buffer {
  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(8, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof]);
}
