/**
 * 画板检查状态（T11.0c，Tony 2026-10-27 定）。纯函数，主进程和界面共用。
 *
 * - 新进画板的图都是「待检查」；以前就有、没有状态的算已看。
 * - AI 检查通过算看过；不通过的和没人检查的留给 Tony（都算「待检查」，显示在画板按钮上）。
 * - 能检查的只有检查、监管者、管理者；出这张图的窗口不能检查自己的图；只能改待检查的。
 * - 标了「不要」的图不算待检查。
 */

import type {
  CanvasBoard,
  CanvasImageNote,
  CanvasPlacedBy,
  CanvasReview,
  WorkbenchRole,
} from "@ff-pane/shared";

export const CANVAS_REVIEWER_ROLES: readonly WorkbenchRole[] = [
  "reviewer",
  "supervisor",
  "manager",
];

/** 这张图要不要 Tony 看（计入「待检查」）。 */
export function needsTonyReview(note: CanvasImageNote | undefined): boolean {
  if (note?.rejected === true) {
    return false;
  }
  const state = note?.review?.state;
  return state === "pending" || state === "ai-fail";
}

/** 画板上（所有页）待检查的图数，同一路径只算一次。 */
export function pendingReviewCount(board: CanvasBoard): number {
  const seen = new Set<string>();
  let count = 0;
  for (const page of board.pages) {
    for (const row of page.rows) {
      for (const version of row.versions) {
        if (seen.has(version.path)) {
          continue;
        }
        seen.add(version.path);
        if (needsTonyReview(board.notes?.[version.path])) {
          count += 1;
        }
      }
    }
  }
  return count;
}

/** 新放进画板的图的状态。 */
export function newImageReview(at: string): CanvasReview {
  return { state: "pending", at };
}

/** 这一版是谁放的（找不到这张图时 undefined）。 */
export function placedByOf(board: CanvasBoard, imagePath: string): CanvasPlacedBy | undefined {
  for (const page of board.pages) {
    for (const row of page.rows) {
      for (const version of row.versions) {
        if (version.path === imagePath) {
          return version.by ?? "dir";
        }
      }
    }
  }
  return undefined;
}

export type AiReviewCheck = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** AI 窗口能不能检查这张图。规则写在代码里，不靠说明书。 */
export function checkAiReview(
  caller: { readonly id: string; readonly role: WorkbenchRole },
  placedBy: CanvasPlacedBy | undefined,
  note: CanvasImageNote | undefined,
): AiReviewCheck {
  if (!CANVAS_REVIEWER_ROLES.includes(caller.role)) {
    return {
      ok: false,
      error: "只有检查、监管者、管理者能检查画板上的图。要检查，请上级开一个检查窗口。",
    };
  }
  if (placedBy === undefined) {
    return { ok: false, error: "画板上没有这张图。" };
  }
  if (placedBy !== "dir" && placedBy.windowId === caller.id) {
    return { ok: false, error: "这张图是你自己放进画板的，不能自己检查。请别的检查窗口来看。" };
  }
  const state = note?.review?.state;
  if (state !== "pending") {
    const label =
      state === "ai-pass"
        ? "已经有 AI 检查通过了"
        : state === "ai-fail"
          ? "已经有 AI 检查不通过，等用户看"
          : "用户已经看过了";
    return { ok: false, error: `这张图${label}，不用再检查。` };
  }
  return { ok: true };
}

export function aiReviewed(pass: boolean, by: string, reason: string, at: string): CanvasReview {
  return { state: pass ? "ai-pass" : "ai-fail", by, reason: reason.trim(), at };
}

/** Tony 点「已看」或打开大图看过。 */
export function seenByTony(at: string): CanvasReview {
  return { state: "seen", at };
}

/** Tony 点「我再看看」：放回待检查。 */
export function reopenReview(at: string): CanvasReview {
  return { state: "pending", at };
}
