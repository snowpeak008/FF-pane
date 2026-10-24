/**
 * T11.0：画板是项目图库。删图进回收站、AI 删图要用户点头、导出、写入排队。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activePage, locatePath } from "@ff-pane/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  ingestCanvasDirectoryFile,
  loadCanvasBoard,
  placeImageOnBoard,
  updateCanvasAnnotations,
} from "../src/main/workbench/canvas-files";
import {
  CANVAS_DELETED_BY_USER,
  exportCanvasImage,
  listCanvasTrash,
  markCanvasRejected,
  purgeCanvasTrash,
  requestCanvasDelete,
  resolveCanvasDeleteRequest,
  restoreCanvasTrash,
  trashCanvasImage,
} from "../src/main/workbench/canvas-library";

const roots: string[] = [];

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-canvas-lib-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function addImage(root: string, name: string): Promise<string> {
  const dir = join(root, ".ffpane", "canvas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), PNG);
  const placed = await placeImageOnBoard(root, `.ffpane/canvas/${name}`, {});
  if (!placed.ok) {
    throw new Error(placed.error);
  }
  return placed.relativePath;
}

const canvasFile = (root: string, name: string): string => join(root, ".ffpane", "canvas", name);

describe("回收站", () => {
  it("用户删图：文件挪进回收站、从画板拿掉；恢复回到原来那一行，标注也回来", async () => {
    const root = project();
    const first = await addImage(root, "a.png");
    const second = await addImage(root, "b.png");
    await updateCanvasAnnotations(root, second, [
      { id: "m1", kind: "label", x: 1, y: 1, w: 2, h: 2, color: "#ef4444", text: "改这里" },
    ]);
    const before = await loadCanvasBoard(root);
    const at = locatePath(before, second);

    const trashed = await trashCanvasImage(root, second);
    expect(trashed.ok).toBe(true);
    expect(existsSync(canvasFile(root, "b.png"))).toBe(false);
    const entries = await listCanvasTrash(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.deletedBy).toBe(CANVAS_DELETED_BY_USER);
    expect(entries[0]?.originalPath).toBe(second);
    expect(locatePath(await loadCanvasBoard(root), second)).toBeUndefined();
    expect(locatePath(await loadCanvasBoard(root), first)).toBeDefined();

    const restored = await restoreCanvasTrash(root, entries[0]?.id ?? "");
    expect(restored.ok).toBe(true);
    expect(existsSync(canvasFile(root, "b.png"))).toBe(true);
    const after = await loadCanvasBoard(root);
    expect(locatePath(after, second)?.pageId).toBe(at?.pageId);
    expect(after.annotations[second]?.[0]?.text).toBe("改这里");
    expect(await listCanvasTrash(root)).toHaveLength(0);
  });

  it("恢复时原名已被占用：换个名字放回，不覆盖", async () => {
    const root = project();
    const path = await addImage(root, "a.png");
    await trashCanvasImage(root, path);
    writeFileSync(canvasFile(root, "a.png"), Buffer.from("new"));
    const [entry] = await listCanvasTrash(root);
    await restoreCanvasTrash(root, entry?.id ?? "");
    expect(readFileSync(canvasFile(root, "a.png")).toString()).toBe("new");
    expect(readdirSync(join(root, ".ffpane", "canvas")).some((n) => n.includes("-restored-"))).toBe(
      true,
    );
  });

  it("彻底删除一张、清空回收站", async () => {
    const root = project();
    await trashCanvasImage(root, await addImage(root, "a.png"));
    await trashCanvasImage(root, await addImage(root, "b.png"));
    const [first] = await listCanvasTrash(root);
    expect((await purgeCanvasTrash(root, first?.id)).ok).toBe(true);
    expect(await listCanvasTrash(root)).toHaveLength(1);
    await purgeCanvasTrash(root, undefined);
    expect(await listCanvasTrash(root)).toHaveLength(0);
    expect(readdirSync(join(root, ".ffpane", "canvas", ".trash"))).toEqual(["trash.json"]);
  });
});

describe("AI 删图", () => {
  it("没标「不要」：图不动，只挂申请；用户保留就撤掉，同意就进回收站", async () => {
    const root = project();
    const path = await addImage(root, "a.png");
    const asked = await requestCanvasDelete(root, path, "执行 1", "不合格");
    expect(asked).toEqual({ ok: true, status: "requested" });
    expect(existsSync(canvasFile(root, "a.png"))).toBe(true);
    expect((await loadCanvasBoard(root)).notes?.[path]?.deleteRequest?.by).toBe("执行 1");

    await resolveCanvasDeleteRequest(root, path, false);
    expect((await loadCanvasBoard(root)).notes?.[path]).toBeUndefined();
    expect(existsSync(canvasFile(root, "a.png"))).toBe(true);

    await requestCanvasDelete(root, path, "执行 1", "不合格");
    await resolveCanvasDeleteRequest(root, path, true);
    expect(existsSync(canvasFile(root, "a.png"))).toBe(false);
    const [entry] = await listCanvasTrash(root);
    expect(entry?.deletedBy).toContain("执行 1");
    expect(entry?.reason).toBe("不合格");
  });

  it("用户标了「不要」：AI 删就直接进回收站", async () => {
    const root = project();
    const path = await addImage(root, "a.png");
    await markCanvasRejected(root, path, true);
    expect(await requestCanvasDelete(root, path, "执行 1", "用户不要")).toEqual({
      ok: true,
      status: "trashed",
    });
    expect(existsSync(canvasFile(root, "a.png"))).toBe(false);
    expect(await listCanvasTrash(root)).toHaveLength(1);
  });

  it("不写原因不行", async () => {
    const root = project();
    const path = await addImage(root, "a.png");
    expect((await requestCanvasDelete(root, path, "执行 1", "  ")).ok).toBe(false);
  });
});

describe("导出", () => {
  it("复制到项目里，原图留在画板，记下导出位置；已存在时要 overwrite", async () => {
    const root = project();
    const path = await addImage(root, "a.png");
    const exported = await exportCanvasImage(root, path, "art/concept/00.png", false);
    expect(exported).toEqual({ ok: true, targetPath: "art/concept/00.png" });
    expect(readFileSync(join(root, "art", "concept", "00.png"))).toEqual(PNG);
    expect(existsSync(canvasFile(root, "a.png"))).toBe(true);
    expect((await loadCanvasBoard(root)).notes?.[path]?.exportedTo).toEqual(["art/concept/00.png"]);
    expect((await exportCanvasImage(root, path, "art/concept/00.png", false)).ok).toBe(false);
    expect((await exportCanvasImage(root, path, "art/concept/00.png", true)).ok).toBe(true);
  });

  it("不能出项目、不能放进 .ffpane、不能换扩展名", async () => {
    const root = project();
    const path = await addImage(root, "a.png");
    for (const target of ["../out.png", "C:/out.png", ".ffpane/x.png", "art/a.jpg", "art//a.png"]) {
      expect((await exportCanvasImage(root, path, target, true)).ok).toBe(false);
    }
  });
});

describe("写入排队", () => {
  it("同时自动收图、放图、改标注：一行都不丢", async () => {
    const root = project();
    const dir = join(root, ".ffpane", "canvas");
    mkdirSync(dir, { recursive: true });
    const names = Array.from({ length: 12 }, (_, index) => `img-${index}.png`);
    for (const name of names) {
      writeFileSync(join(dir, name), PNG);
    }
    await Promise.all(
      names.map((name, index) =>
        index % 2 === 0
          ? ingestCanvasDirectoryFile(root, name)
          : placeImageOnBoard(root, `.ffpane/canvas/${name}`, {}),
      ),
    );
    const board = await loadCanvasBoard(root);
    const paths = activePage(board).rows.flatMap((row) => row.versions.map((v) => v.path));
    expect(new Set(paths)).toEqual(new Set(names.map((name) => `.ffpane/canvas/${name}`)));
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("打开画板时清掉超过 10 分钟的临时文件，新的不动", async () => {
    const root = project();
    const dir = join(root, ".ffpane", "canvas");
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, ".board.json.11111111-1111-4111-8111-111111111111.tmp");
    const fresh = join(dir, ".board.json.22222222-2222-4222-8222-222222222222.tmp");
    writeFileSync(stale, "x");
    writeFileSync(fresh, "x");
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(stale, old, old);
    await loadCanvasBoard(root);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
