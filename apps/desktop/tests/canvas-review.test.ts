/**
 * T11.0c：画板检查状态的规则。
 */

import { type CanvasBoard, defaultCanvasBoard } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  aiReviewed,
  checkAiReview,
  needsTonyReview,
  newImageReview,
  pendingReviewCount,
  placedByOf,
  reopenReview,
  seenByTony,
} from "../src/shared/workbench/canvas-review";

const at = "2026-10-27T00:00:00Z";

function board(): CanvasBoard {
  return {
    ...defaultCanvasBoard(),
    pages: [
      {
        id: "page-1",
        title: "1",
        rows: [
          {
            id: "r1",
            versions: [
              { path: "a.png", addedAt: at, by: { windowId: "win-exec", title: "执行1" } },
              { path: "b.png", addedAt: at, by: "dir" },
            ],
          },
          { id: "r2", versions: [{ path: "old.png", addedAt: at }] },
        ],
      },
      {
        id: "page-2",
        title: "2",
        rows: [{ id: "r3", versions: [{ path: "c.png", addedAt: at }] }],
      },
    ],
    notes: {
      "a.png": { review: newImageReview(at) },
      "b.png": { review: aiReviewed(false, "检查1", "颜色不对", at) },
      "c.png": { review: newImageReview(at), rejected: true },
    },
  };
}

describe("待检查", () => {
  it("待检查和 AI 不通过的算，AI 通过、已看、以前的、标了不要的不算", () => {
    expect(needsTonyReview({ review: newImageReview(at) })).toBe(true);
    expect(needsTonyReview({ review: aiReviewed(false, "x", "y", at) })).toBe(true);
    expect(needsTonyReview({ review: aiReviewed(true, "x", "y", at) })).toBe(false);
    expect(needsTonyReview({ review: seenByTony(at) })).toBe(false);
    expect(needsTonyReview(undefined)).toBe(false);
    expect(needsTonyReview({ review: newImageReview(at), rejected: true })).toBe(false);
    expect(pendingReviewCount(board())).toBe(2);
  });

  it("我再看看：放回待检查", () => {
    expect(reopenReview(at).state).toBe("pending");
  });
});

describe("AI 检查", () => {
  const b = board();

  it("执行不能检查", () => {
    const result = checkAiReview(
      { id: "win-x", role: "worker" },
      placedByOf(b, "a.png"),
      b.notes?.["a.png"],
    );
    expect(result.ok).toBe(false);
  });

  it("出图的窗口不能检查自己的图，别的检查窗口可以", () => {
    const placed = placedByOf(b, "a.png");
    const note = b.notes?.["a.png"];
    expect(checkAiReview({ id: "win-exec", role: "reviewer" }, placed, note).ok).toBe(false);
    expect(checkAiReview({ id: "win-rev", role: "reviewer" }, placed, note).ok).toBe(true);
    expect(checkAiReview({ id: "win-mgr", role: "manager" }, placed, note).ok).toBe(true);
  });

  it("只能改待检查的；画板上没有的报错", () => {
    expect(
      checkAiReview({ id: "win-rev", role: "reviewer" }, placedByOf(b, "b.png"), b.notes?.["b.png"])
        .ok,
    ).toBe(false);
    expect(
      checkAiReview({ id: "win-rev", role: "supervisor" }, placedByOf(b, "old.png"), undefined).ok,
    ).toBe(false);
    expect(
      checkAiReview({ id: "win-rev", role: "reviewer" }, placedByOf(b, "nope.png"), undefined).ok,
    ).toBe(false);
  });

  it("没记来源的当目录收进来的", () => {
    expect(placedByOf(b, "old.png")).toBe("dir");
  });
});
