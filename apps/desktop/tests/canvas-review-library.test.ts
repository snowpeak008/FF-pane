/**
 * T11.0c：新图待检查、记下谁放的；AI 检查、Tony 已看 / 再看看；拖动位置存进画板。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ingestCanvasDirectoryFile,
  loadCanvasBoard,
  placeImageOnBoard,
} from "../src/main/workbench/canvas-files";
import {
  aiReviewCanvasImage,
  placeCanvasRow,
  setCanvasReview,
} from "../src/main/workbench/canvas-library";
import { pendingReviewCount } from "../src/shared/workbench/canvas-review";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-review-"));
  roots.push(dir);
  mkdirSync(join(dir, ".ffpane", "canvas"), { recursive: true });
  return dir;
}

function image(root: string, name: string): string {
  writeFileSync(join(root, ".ffpane", "canvas", name), PNG);
  return `.ffpane/canvas/${name}`;
}

const exec = { id: "win-exec", title: "执行1", role: "worker" as const };
const reviewer = { id: "win-rev", title: "检查1", role: "reviewer" as const };

describe("新图待检查", () => {
  it("放图和目录收图都记成待检查，并记下是谁放的", async () => {
    const root = project();
    const a = image(root, "a.png");
    await placeImageOnBoard(root, a, { by: { windowId: exec.id, title: exec.title } });
    image(root, "b.png");
    await ingestCanvasDirectoryFile(root, "b.png");
    const board = await loadCanvasBoard(root);
    const versions = board.pages.flatMap((p) => p.rows.flatMap((r) => r.versions));
    expect(versions.find((v) => v.path === a)?.by).toEqual({
      windowId: "win-exec",
      title: "执行1",
    });
    expect(versions.find((v) => v.path === ".ffpane/canvas/b.png")?.by).toBe("dir");
    expect(board.notes?.[a]?.review?.state).toBe("pending");
    expect(pendingReviewCount(board)).toBe(2);
  });

  it("以前就有、没有状态的图不算待检查", async () => {
    const root = project();
    const old = image(root, "old.png");
    writeFileSync(
      join(root, ".ffpane", "canvas", "board.json"),
      JSON.stringify({
        v: 1,
        pages: [
          {
            id: "page-1",
            title: "1",
            rows: [{ id: "r", versions: [{ path: old, addedAt: "x" }] }],
          },
        ],
        annotations: {},
      }),
    );
    expect(pendingReviewCount(await loadCanvasBoard(root))).toBe(0);
  });
});

describe("检查", () => {
  it("出图的窗口查不了自己的图；检查窗口查了以后别人不能再改", async () => {
    const root = project();
    const a = image(root, "a.png");
    await placeImageOnBoard(root, a, { by: { windowId: exec.id, title: exec.title } });
    const own = await aiReviewCanvasImage(root, a, { ...exec, role: "reviewer" }, true, "好");
    expect(own.ok).toBe(false);
    const done = await aiReviewCanvasImage(root, a, reviewer, false, "颜色不对");
    expect(done.ok).toBe(true);
    const board = await loadCanvasBoard(root);
    expect(board.notes?.[a]?.review).toMatchObject({
      state: "ai-fail",
      by: "检查1",
      reason: "颜色不对",
    });
    expect(pendingReviewCount(board)).toBe(1);
    const again = await aiReviewCanvasImage(
      root,
      a,
      { id: "win-rev2", title: "检查2", role: "reviewer" },
      true,
      "其实可以",
    );
    expect(again.ok).toBe(false);
  });

  it("Tony 点已看就不算待检查；再看看又放回去", async () => {
    const root = project();
    const a = image(root, "a.png");
    await placeImageOnBoard(root, a, {});
    expect((await setCanvasReview(root, a, "seen")).ok).toBe(true);
    expect(pendingReviewCount(await loadCanvasBoard(root))).toBe(0);
    await setCanvasReview(root, a, "pending");
    expect(pendingReviewCount(await loadCanvasBoard(root))).toBe(1);
  });
});

describe("拖动位置", () => {
  it("存进画板，清掉后回到自动排；没有这一行报错", async () => {
    const root = project();
    const a = image(root, "a.png");
    await placeImageOnBoard(root, a, { rowId: "row-a" });
    expect((await placeCanvasRow(root, "row-a", { x: 120.4, y: 80.6 })).ok).toBe(true);
    expect((await loadCanvasBoard(root)).placements).toEqual({ "row-a": { x: 120, y: 81 } });
    await placeCanvasRow(root, "row-a", undefined);
    expect((await loadCanvasBoard(root)).placements).toBeUndefined();
    expect((await placeCanvasRow(root, "nope", { x: 0, y: 0 })).ok).toBe(false);
  });
});
