/**
 * 项目画板数据：只读写 `<项目根>/.ffpane/canvas/`（board.json、图片、修改要求）。
 * 原图像素不改。文字和带标记的预览写在 `revisions/`。
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  activePage,
  addImageAsNewRow,
  appendVersionToRow,
  type CanvasAnnotation,
  type CanvasBoard,
  defaultCanvasBoard,
  isCanvasImageFileName,
  parseCanvasBoard,
  removePathFromBoard,
  setAnnotationsForPath,
} from "@ff-pane/shared";
import {
  buildCanvasRevisionFile,
  CANVAS_REVISIONS_DIR,
  type CanvasRevisionForTool,
  canvasRevisionRelative,
  isCanvasDerivedFileName,
  readRasterSize,
  shouldIngestCanvasFileName,
  sourceImageNameFromDerived,
} from "./canvas-revision";
import { lexicalFfPanePath, resolveFfPaneFile } from "./panel-files";

export type { CanvasRevisionForTool } from "./canvas-revision";

export const CANVAS_SUBDIR = "canvas";
export const CANVAS_BOARD_NAME = "board.json";
export const CANVAS_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

function canvasDirLexical(projectRoot: string): string {
  return join(resolve(projectRoot), ".ffpane", CANVAS_SUBDIR);
}

export function canvasBoardRelativePath(): string {
  return `.ffpane/${CANVAS_SUBDIR}/${CANVAS_BOARD_NAME}`;
}

/** 词法上把路径收进 `.ffpane/canvas/`。 */
export function lexicalCanvasPath(
  projectRoot: string,
  relativePath: string,
):
  | { readonly ok: true; readonly absolute: string; readonly relative: string }
  | { readonly ok: false; readonly error: string } {
  const normalized = relativePath.trim().replace(/\\/g, "/");
  const withPrefix = normalized.startsWith(".ffpane/")
    ? normalized
    : `.ffpane/${CANVAS_SUBDIR}/${normalized.replace(/^canvas\//, "")}`;
  const lexical = lexicalFfPanePath(projectRoot, withPrefix);
  if (!lexical.ok) {
    return lexical;
  }
  const canvasRoot = canvasDirLexical(projectRoot);
  if (!lexical.absolute.startsWith(canvasRoot + sep) && lexical.absolute !== canvasRoot) {
    return { ok: false, error: "路径必须落在 .ffpane/canvas/ 内。" };
  }
  const name = basename(lexical.absolute);
  if (name === CANVAS_BOARD_NAME) {
    return { ok: false, error: "不能对 board.json 使用该操作。" };
  }
  if (isCanvasDerivedFileName(name) || normalized.includes("/revisions/")) {
    return { ok: false, error: "这是修改要求的预览，不是要改的原图。" };
  }
  if (!isCanvasImageFileName(name)) {
    return { ok: false, error: "只接受常见图片扩展名。" };
  }
  const relFromProject = `.ffpane/${CANVAS_SUBDIR}/${name}`;
  return { ok: true, absolute: lexical.absolute, relative: relFromProject };
}

export async function resolveCanvasImage(
  projectRoot: string,
  relativePath: string,
): Promise<
  | { readonly ok: true; readonly absolute: string; readonly relative: string }
  | { readonly ok: false; readonly error: string }
> {
  const lexical = lexicalCanvasPath(projectRoot, relativePath);
  if (!lexical.ok) {
    return lexical;
  }
  const resolved = await resolveFfPaneFile(projectRoot, lexical.relative);
  if (!resolved.ok) {
    return resolved;
  }
  try {
    const stat = await lstat(resolved.absolute);
    if (!stat.isFile()) {
      return { ok: false, error: "目标不是普通文件。" };
    }
    if (stat.size > CANVAS_IMAGE_MAX_BYTES) {
      return { ok: false, error: "图片过大。" };
    }
  } catch {
    return { ok: false, error: "找不到图片文件。" };
  }
  return { ok: true, absolute: resolved.absolute, relative: lexical.relative };
}

async function readBoardFile(projectRoot: string): Promise<CanvasBoard> {
  const boardPath = join(canvasDirLexical(projectRoot), CANVAS_BOARD_NAME);
  try {
    const text = await readFile(boardPath, "utf8");
    const parsed = parseCanvasBoard(JSON.parse(text) as unknown);
    if (parsed !== undefined) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return defaultCanvasBoard();
}

async function writeAtomic(target: string, data: Buffer | string): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
}

async function sweepRevisionDir(dir: string, keep: ReadonlySet<string>): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const source = sourceImageNameFromDerived(name);
    if (source === undefined || keep.has(source)) {
      continue;
    }
    await unlink(join(dir, name)).catch(() => undefined);
  }
}

/** 按当前标注重写文字要求，并删掉已经没有标注的预览。 */
async function syncCanvasRevisions(projectRoot: string, board: CanvasBoard): Promise<void> {
  const dir = join(canvasDirLexical(projectRoot), CANVAS_REVISIONS_DIR);
  const keep = new Set<string>();
  for (const [rel, items] of Object.entries(board.annotations)) {
    if (items.length === 0) {
      continue;
    }
    const resolved = await resolveCanvasImage(projectRoot, rel);
    if (!resolved.ok) {
      continue;
    }
    const imageFileName = basename(resolved.absolute);
    const bytes = await readFile(resolved.absolute);
    const brief = buildCanvasRevisionFile(
      resolved.relative,
      imageFileName,
      items,
      readRasterSize(bytes),
    );
    if (brief === undefined) {
      continue;
    }
    keep.add(imageFileName);
    const lexical = lexicalFfPanePath(projectRoot, canvasRevisionRelative(imageFileName).json);
    if (!lexical.ok) {
      continue;
    }
    await writeAtomic(lexical.absolute, `${JSON.stringify(brief, null, 2)}\n`);
  }
  await sweepRevisionDir(dir, keep);
}

async function writeBoardFile(projectRoot: string, board: CanvasBoard): Promise<void> {
  const target = join(canvasDirLexical(projectRoot), CANVAS_BOARD_NAME);
  await writeAtomic(target, `${JSON.stringify(board, null, 2)}\n`);
  await syncCanvasRevisions(projectRoot, board);
}

export async function loadCanvasBoard(projectRoot: string): Promise<CanvasBoard> {
  return readBoardFile(projectRoot);
}

export async function saveCanvasBoard(projectRoot: string, board: CanvasBoard): Promise<void> {
  await writeBoardFile(projectRoot, board);
}

export async function placeImageOnBoard(
  projectRoot: string,
  imageRelativePath: string,
  options: { readonly rowId?: string; readonly asNewVersion?: boolean },
): Promise<
  | { readonly ok: true; readonly board: CanvasBoard; readonly relativePath: string }
  | { readonly ok: false; readonly error: string }
> {
  const resolved = await resolveCanvasImage(projectRoot, imageRelativePath);
  if (!resolved.ok) {
    return resolved;
  }
  let board = await readBoardFile(projectRoot);
  const addedAt = new Date().toISOString();
  const rowId = options.rowId?.trim();
  if (rowId !== undefined && rowId !== "" && options.asNewVersion) {
    const before = activePage(board).rows.find((row) => row.id === rowId);
    board = before
      ? appendVersionToRow(board, rowId, resolved.relative, addedAt)
      : addImageAsNewRow(board, resolved.relative, rowId, addedAt);
  } else if (rowId !== undefined && rowId !== "") {
    board = addImageAsNewRow(board, resolved.relative, rowId, addedAt);
  } else {
    board = addImageAsNewRow(board, resolved.relative, `row-${randomUUID()}`, addedAt);
  }
  await writeBoardFile(projectRoot, board);
  return { ok: true, board, relativePath: resolved.relative };
}

export async function removeFromCanvasBoard(
  projectRoot: string,
  imageRelativePath: string,
): Promise<
  | { readonly ok: true; readonly board: CanvasBoard }
  | { readonly ok: false; readonly error: string }
> {
  const lexical = lexicalCanvasPath(projectRoot, imageRelativePath);
  if (!lexical.ok) {
    return lexical;
  }
  let board = await readBoardFile(projectRoot);
  board = removePathFromBoard(board, lexical.relative);
  await writeBoardFile(projectRoot, board);
  return { ok: true, board };
}

export async function updateCanvasAnnotations(
  projectRoot: string,
  imageRelativePath: string,
  annotations: readonly CanvasAnnotation[],
): Promise<
  | { readonly ok: true; readonly board: CanvasBoard }
  | { readonly ok: false; readonly error: string }
> {
  const resolved = await resolveCanvasImage(projectRoot, imageRelativePath);
  if (!resolved.ok) {
    return resolved;
  }
  let board = await readBoardFile(projectRoot);
  board = setAnnotationsForPath(board, resolved.relative, annotations);
  await writeBoardFile(projectRoot, board);
  return { ok: true, board };
}

export async function deleteCanvasImageFile(
  projectRoot: string,
  imageRelativePath: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const resolved = await resolveCanvasImage(projectRoot, imageRelativePath);
  if (!resolved.ok) {
    return resolved;
  }
  try {
    await unlink(resolved.absolute);
  } catch {
    return { ok: false, error: "删除文件失败。" };
  }
  let board = await readBoardFile(projectRoot);
  board = removePathFromBoard(board, resolved.relative);
  await writeBoardFile(projectRoot, board);
  return { ok: true };
}

export async function readCanvasImageBytes(
  projectRoot: string,
  imageRelativePath: string,
): Promise<
  | { readonly ok: true; readonly mime: string; readonly base64: string }
  | { readonly ok: false; readonly error: string }
> {
  const resolved = await resolveCanvasImage(projectRoot, imageRelativePath);
  if (!resolved.ok) {
    return resolved;
  }
  const buf = await readFile(resolved.absolute);
  const name = basename(resolved.absolute).toLowerCase();
  const mime = name.endsWith(".png")
    ? "image/png"
    : name.endsWith(".webp")
      ? "image/webp"
      : name.endsWith(".gif")
        ? "image/gif"
        : "image/jpeg";
  return { ok: true, mime, base64: buf.toString("base64") };
}

export async function canvasImageSha256(
  projectRoot: string,
  imageRelativePath: string,
): Promise<
  { readonly ok: true; readonly digest: string } | { readonly ok: false; readonly error: string }
> {
  const resolved = await resolveCanvasImage(projectRoot, imageRelativePath);
  if (!resolved.ok) {
    return resolved;
  }
  const buf = await readFile(resolved.absolute);
  return { ok: true, digest: createHash("sha256").update(buf).digest("hex") };
}

export async function describeCanvasRevision(
  projectRoot: string,
  imageRelativePath: string,
): Promise<CanvasRevisionForTool | undefined> {
  const resolved = await resolveCanvasImage(projectRoot, imageRelativePath);
  if (!resolved.ok) {
    return undefined;
  }
  const board = await readBoardFile(projectRoot);
  const items = board.annotations[resolved.relative];
  if (items === undefined || items.length === 0) {
    return undefined;
  }
  const bytes = await readFile(resolved.absolute);
  const brief = buildCanvasRevisionFile(
    resolved.relative,
    basename(resolved.absolute),
    items,
    readRasterSize(bytes),
  );
  if (brief === undefined) {
    return undefined;
  }
  const marked = lexicalFfPanePath(projectRoot, brief.markedImage);
  let markedImageReady = false;
  if (marked.ok) {
    try {
      const stat = await lstat(marked.absolute);
      markedImageReady = stat.isFile() && !stat.isSymbolicLink();
    } catch {
      markedImageReady = false;
    }
  }
  return { ...brief, markedImageReady };
}

export async function writeCanvasMarkedPreview(
  projectRoot: string,
  imageRelativePath: string,
  pngBase64: string,
): Promise<
  | { readonly ok: true; readonly relativePath: string }
  | { readonly ok: false; readonly error: string }
> {
  const resolved = await resolveCanvasImage(projectRoot, imageRelativePath);
  if (!resolved.ok) {
    return resolved;
  }
  const board = await readBoardFile(projectRoot);
  const items = board.annotations[resolved.relative];
  if (items === undefined || items.length === 0) {
    return { ok: false, error: "这张图没有标注，不保存带标记的预览。" };
  }
  const cleaned = pngBase64.trim().replace(/^data:image\/png;base64,/, "");
  if (cleaned.length === 0 || cleaned.length > Math.ceil((CANVAS_IMAGE_MAX_BYTES * 4) / 3) + 8) {
    return { ok: false, error: "带标记的预览过大或为空。" };
  }
  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length === 0 || bytes.length > CANVAS_IMAGE_MAX_BYTES) {
    return { ok: false, error: "带标记的预览过大或为空。" };
  }
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes.toString("ascii", 1, 4) !== "PNG") {
    return { ok: false, error: "带标记的预览必须是 PNG。" };
  }
  const relativePath = canvasRevisionRelative(basename(resolved.absolute)).marked;
  const lexical = lexicalFfPanePath(projectRoot, relativePath);
  if (!lexical.ok) {
    return lexical;
  }
  const revisionsRoot = join(canvasDirLexical(projectRoot), CANVAS_REVISIONS_DIR);
  if (!lexical.absolute.startsWith(`${revisionsRoot}${sep}`)) {
    return { ok: false, error: "预览路径无效。" };
  }
  await writeAtomic(lexical.absolute, bytes);
  return { ok: true, relativePath };
}

export async function ingestCanvasDirectoryFile(
  projectRoot: string,
  fileName: string,
): Promise<void> {
  if (!shouldIngestCanvasFileName(fileName)) {
    return;
  }
  const relative = `.ffpane/${CANVAS_SUBDIR}/${fileName}`;
  const resolved = await resolveCanvasImage(projectRoot, relative);
  if (!resolved.ok) {
    return;
  }
  const board = await readBoardFile(projectRoot);
  const exists = board.pages.some((page) =>
    page.rows.some((row) => row.versions.some((version) => version.path === resolved.relative)),
  );
  if (exists) {
    return;
  }
  const next = addImageAsNewRow(
    board,
    resolved.relative,
    `row-${randomUUID()}`,
    new Date().toISOString(),
  );
  await writeBoardFile(projectRoot, next);
}
