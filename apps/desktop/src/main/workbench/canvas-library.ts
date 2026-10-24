/**
 * 画板是项目图库（T11.0）：删图进回收站、AI 删图要用户点头、导出到项目里。
 *
 * - 回收站：`.ffpane/canvas/.trash/`，图片原样挪进去，`trash.json` 记谁删的、什么时候、原因、原来在哪一页哪一行。
 * - 用户在画板上删图 → 进回收站。用户可以把图标成「不要」。
 * - AI 删图：图被标了「不要」→ 进回收站；没标 → 不删，在图上挂一条申请，等用户同意或保留。
 * - 恢复、彻底删除、清空回收站只走界面（用户），AI 工具调用不到。
 * - 导出：复制到项目里指定的位置，原图留在画板，图上记下导出到哪里。
 *
 * 所有读改写都在 withCanvasLock 里，和自动收图、放图、标注排同一条队。
 */

import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import {
  type CanvasAnnotation,
  type CanvasBoard,
  locatePath,
  placePathAt,
  removePathFromBoard,
  setAnnotationsForPath,
  setImageNote,
} from "@ff-pane/shared";
import {
  CANVAS_SUBDIR,
  canvasDirectory,
  readCanvasBoardFile,
  renameWithRetry,
  resolveCanvasImage,
  withCanvasLock,
  writeAtomic,
  writeCanvasBoardFile,
} from "./canvas-files";
import { stripControls } from "./remind";

export const CANVAS_TRASH_DIR = ".trash";
const TRASH_INDEX = "trash.json";
/** 用户删的记成这个；AI 删的记窗口标题。 */
export const CANVAS_DELETED_BY_USER = "用户";
const REASON_MAX_CHARS = 200;

export interface CanvasTrashEntry {
  readonly id: string;
  /** 回收站里的文件名。 */
  readonly fileName: string;
  /** 原来的路径（`.ffpane/canvas/xxx.png`）。 */
  readonly originalPath: string;
  readonly pageId?: string;
  readonly rowId?: string;
  readonly deletedBy: string;
  readonly deletedAt: string;
  readonly reason?: string;
  /** 删的时候图上的标注，恢复时一起放回去。 */
  readonly annotations?: readonly CanvasAnnotation[];
}

type Result<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly error: string };

function trashDir(projectRoot: string): string {
  return join(canvasDirectory(projectRoot), CANVAS_TRASH_DIR);
}

function cleanReason(reason: string | undefined): string | undefined {
  const text = stripControls(reason ?? "").trim();
  return text === "" ? undefined : text.slice(0, REASON_MAX_CHARS);
}

async function readTrash(projectRoot: string): Promise<CanvasTrashEntry[]> {
  try {
    const raw = JSON.parse(
      await readFile(join(trashDir(projectRoot), TRASH_INDEX), "utf8"),
    ) as unknown;
    const entries = (raw as { readonly entries?: unknown }).entries;
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries.filter(
      (entry): entry is CanvasTrashEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as CanvasTrashEntry).id === "string" &&
        typeof (entry as CanvasTrashEntry).fileName === "string" &&
        typeof (entry as CanvasTrashEntry).originalPath === "string" &&
        !(entry as CanvasTrashEntry).fileName.includes("/") &&
        !(entry as CanvasTrashEntry).fileName.includes("\\"),
    );
  } catch {
    return [];
  }
}

async function writeTrash(
  projectRoot: string,
  entries: readonly CanvasTrashEntry[],
): Promise<void> {
  await writeAtomic(
    join(trashDir(projectRoot), TRASH_INDEX),
    `${JSON.stringify({ v: 1, entries }, null, 2)}\n`,
  );
}

/** 挪进回收站。调用方已经拿着锁、读好了画板。返回改过的画板。 */
async function moveToTrash(
  projectRoot: string,
  board: CanvasBoard,
  relative: string,
  absolute: string,
  deletedBy: string,
  reason: string | undefined,
): Promise<CanvasBoard> {
  const id = randomUUID();
  const fileName = `${id}__${basename(absolute)}`;
  await mkdir(trashDir(projectRoot), { recursive: true });
  await renameWithRetry(absolute, join(trashDir(projectRoot), fileName));
  const at = locatePath(board, relative);
  const annotations = board.annotations[relative];
  const entry: CanvasTrashEntry = {
    id,
    fileName,
    originalPath: relative,
    ...(at !== undefined ? { pageId: at.pageId, rowId: at.rowId } : {}),
    deletedBy,
    deletedAt: new Date().toISOString(),
    ...(reason !== undefined ? { reason } : {}),
    ...(annotations !== undefined && annotations.length > 0 ? { annotations } : {}),
  };
  await writeTrash(projectRoot, [entry, ...(await readTrash(projectRoot))]);
  const next = removePathFromBoard(board, relative);
  await writeCanvasBoardFile(projectRoot, next);
  return next;
}

export async function listCanvasTrash(projectRoot: string): Promise<readonly CanvasTrashEntry[]> {
  return withCanvasLock(projectRoot, () => readTrash(projectRoot));
}

/** 用户在画板上删一张图：进回收站。 */
export async function trashCanvasImage(
  projectRoot: string,
  imagePath: string,
): Promise<Result<{ readonly board: CanvasBoard }>> {
  const resolved = await resolveCanvasImage(projectRoot, imagePath);
  if (!resolved.ok) {
    return resolved;
  }
  return withCanvasLock(projectRoot, async () => {
    const board = await readCanvasBoardFile(projectRoot);
    const next = await moveToTrash(
      projectRoot,
      board,
      resolved.relative,
      resolved.absolute,
      CANVAS_DELETED_BY_USER,
      undefined,
    );
    return { ok: true as const, board: next };
  });
}

/**
 * AI 窗口要删一张图。被用户标了「不要」就进回收站；没标就只挂申请，图不动。
 * 同一张图已经有申请时，用新的原因替换。
 */
export async function requestCanvasDelete(
  projectRoot: string,
  imagePath: string,
  by: string,
  reason: string,
): Promise<Result<{ readonly status: "trashed" | "requested" }>> {
  const why = cleanReason(reason);
  if (why === undefined) {
    return { ok: false, error: "删图要写原因（reason）。" };
  }
  const resolved = await resolveCanvasImage(projectRoot, imagePath);
  if (!resolved.ok) {
    return resolved;
  }
  return withCanvasLock(projectRoot, async () => {
    const board = await readCanvasBoardFile(projectRoot);
    if (board.notes?.[resolved.relative]?.rejected === true) {
      await moveToTrash(projectRoot, board, resolved.relative, resolved.absolute, by, why);
      return { ok: true as const, status: "trashed" as const };
    }
    const next = setImageNote(board, resolved.relative, (note) => ({
      ...note,
      deleteRequest: { by, reason: why, at: new Date().toISOString() },
    }));
    await writeCanvasBoardFile(projectRoot, next);
    return { ok: true as const, status: "requested" as const };
  });
}

/** 用户处理删图申请：同意就进回收站（记申请的窗口和原因），保留就撤掉申请。 */
export async function resolveCanvasDeleteRequest(
  projectRoot: string,
  imagePath: string,
  approve: boolean,
): Promise<Result<{ readonly board: CanvasBoard }>> {
  const resolved = await resolveCanvasImage(projectRoot, imagePath);
  if (!resolved.ok) {
    return resolved;
  }
  return withCanvasLock(projectRoot, async () => {
    const board = await readCanvasBoardFile(projectRoot);
    const request = board.notes?.[resolved.relative]?.deleteRequest;
    if (request === undefined) {
      return { ok: true as const, board };
    }
    if (approve) {
      const next = await moveToTrash(
        projectRoot,
        board,
        resolved.relative,
        resolved.absolute,
        `${request.by}（${CANVAS_DELETED_BY_USER}同意）`,
        request.reason,
      );
      return { ok: true as const, board: next };
    }
    const next = setImageNote(board, resolved.relative, (note) => {
      const { deleteRequest: _dropped, ...rest } = note;
      return rest;
    });
    await writeCanvasBoardFile(projectRoot, next);
    return { ok: true as const, board: next };
  });
}

/** 用户把图标成「不要」或取消标记。不删图。 */
export async function markCanvasRejected(
  projectRoot: string,
  imagePath: string,
  rejected: boolean,
): Promise<Result<{ readonly board: CanvasBoard }>> {
  const resolved = await resolveCanvasImage(projectRoot, imagePath);
  if (!resolved.ok) {
    return resolved;
  }
  return withCanvasLock(projectRoot, async () => {
    const board = await readCanvasBoardFile(projectRoot);
    const next = setImageNote(board, resolved.relative, (note) => ({ ...note, rejected }));
    await writeCanvasBoardFile(projectRoot, next);
    return { ok: true as const, board: next };
  });
}

/** 从回收站恢复到原来的页和行。同名文件已经有了就换个名字放回。 */
export async function restoreCanvasTrash(
  projectRoot: string,
  id: string,
): Promise<Result<{ readonly board: CanvasBoard }>> {
  return withCanvasLock(projectRoot, async () => {
    const entries = await readTrash(projectRoot);
    const entry = entries.find((item) => item.id === id);
    if (entry === undefined) {
      return { ok: false as const, error: "回收站里没有这张图。" };
    }
    const original = basename(entry.originalPath);
    let name = original;
    try {
      await lstat(join(canvasDirectory(projectRoot), name));
      const ext = extname(original);
      name = `${original.slice(0, original.length - ext.length)}-restored-${id.slice(0, 8)}${ext}`;
    } catch {
      // 原名空着，直接放回
    }
    const relative = `.ffpane/${CANVAS_SUBDIR}/${name}`;
    // 先挪回文件再写画板：挪不回来就不动画板。自动收图排在这把锁后面，轮到它时图已经在画板上了。
    await renameWithRetry(
      join(trashDir(projectRoot), entry.fileName),
      join(canvasDirectory(projectRoot), name),
    );
    let board = placePathAt(
      await readCanvasBoardFile(projectRoot),
      relative,
      {
        ...(entry.pageId !== undefined ? { pageId: entry.pageId } : {}),
        ...(entry.rowId !== undefined ? { rowId: entry.rowId } : {}),
      },
      `row-${randomUUID()}`,
      new Date().toISOString(),
    );
    if (entry.annotations !== undefined) {
      board = setAnnotationsForPath(board, relative, entry.annotations);
    }
    await writeCanvasBoardFile(projectRoot, board);
    await writeTrash(
      projectRoot,
      entries.filter((item) => item.id !== id),
    );
    return { ok: true as const, board };
  });
}

/** 彻底删除回收站里的一张，或清空（id 为 undefined）。只给界面用。 */
export async function purgeCanvasTrash(
  projectRoot: string,
  id: string | undefined,
): Promise<Result<{ readonly remaining: number }>> {
  return withCanvasLock(projectRoot, async () => {
    const entries = await readTrash(projectRoot);
    const doomed = entries.filter((item) => id === undefined || item.id === id);
    if (id !== undefined && doomed.length === 0) {
      return { ok: false as const, error: "回收站里没有这张图。" };
    }
    const kept: CanvasTrashEntry[] = entries.filter((item) => !doomed.includes(item));
    for (const entry of doomed) {
      try {
        await unlink(join(trashDir(projectRoot), entry.fileName));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          kept.push(entry);
        }
      }
    }
    await writeTrash(projectRoot, kept);
    return { ok: true as const, remaining: kept.length };
  });
}

/** 导出目标：项目里的相对路径，不能出项目根，不能放进 .ffpane，扩展名和原图一致。 */
async function resolveExportTarget(
  projectRoot: string,
  target: string,
  sourceName: string,
): Promise<Result<{ readonly absolute: string; readonly relative: string }>> {
  const normalized = target.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === "" || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return { ok: false, error: "targetPath 要写项目里的相对路径。" };
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    return { ok: false, error: "targetPath 不能含 .. 或空的目录名。" };
  }
  if (parts[0]?.toLowerCase() === ".ffpane") {
    return { ok: false, error: "不能导出到 .ffpane 里；要放进项目自己的目录。" };
  }
  if (extname(normalized).toLowerCase() !== extname(sourceName).toLowerCase()) {
    return { ok: false, error: `扩展名要和原图一致（${extname(sourceName)}），导出不转格式。` };
  }
  const root = resolve(projectRoot);
  const absolute = resolve(root, normalized);
  if (!absolute.startsWith(`${root}${sep}`)) {
    return { ok: false, error: "targetPath 不能出项目目录。" };
  }
  // 已有的上级目录不能是指到项目外的链接。
  let probe = dirname(absolute);
  for (;;) {
    try {
      const real = await realpath(probe);
      const realRoot = await realpath(root);
      if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
        return { ok: false, error: "targetPath 不能出项目目录。" };
      }
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe || !parent.startsWith(root)) {
        break;
      }
      probe = parent;
    }
  }
  return { ok: true, absolute, relative: parts.join("/") };
}

/** 把画板上的图复制到项目里。原图留在画板，图上记下导出到哪里。 */
export async function exportCanvasImage(
  projectRoot: string,
  imagePath: string,
  targetPath: string,
  overwrite: boolean,
): Promise<Result<{ readonly targetPath: string }>> {
  const resolved = await resolveCanvasImage(projectRoot, imagePath);
  if (!resolved.ok) {
    return resolved;
  }
  const target = await resolveExportTarget(projectRoot, targetPath, basename(resolved.absolute));
  if (!target.ok) {
    return target;
  }
  if (!overwrite) {
    try {
      await lstat(target.absolute);
      return { ok: false, error: "目标已经有文件了。要覆盖请传 overwrite: true。" };
    } catch {
      // 目标空着
    }
  }
  return withCanvasLock(projectRoot, async () => {
    await mkdir(dirname(target.absolute), { recursive: true });
    await copyFile(resolved.absolute, target.absolute);
    const board = await readCanvasBoardFile(projectRoot);
    const next = setImageNote(board, resolved.relative, (note) => ({
      ...note,
      exportedTo: [
        ...(note.exportedTo ?? []).filter((item) => item !== target.relative),
        target.relative,
      ],
    }));
    await writeCanvasBoardFile(projectRoot, next);
    return { ok: true as const, targetPath: target.relative };
  });
}
