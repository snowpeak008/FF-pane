/**
 * 项目画板数据：只读写 `<项目根>/.ffpane/canvas/`（board.json、图片、修改要求）。
 * 原图像素不改。文字和带标记的预览写在 `revisions/`。
 * 同一个项目的画板读改写排队（withCanvasLock）：自动收图、放图、标注、删图、界面操作同时来也不会互相覆盖。
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  activePage,
  addImageAsNewRow,
  appendVersionToRow,
  type CanvasAnnotation,
  type CanvasBoard,
  dedupeCanvasBoard,
  defaultCanvasBoard,
  detachVersion,
  isCanvasImageFileName,
  locatePath,
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

const canvasQueues = new Map<string, Promise<unknown>>();

/** 同一个项目的画板读改写一次一个。画板数据只能在这里面读出来改、再写回去。 */
export function withCanvasLock<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(projectRoot).toLowerCase();
  const previous = canvasQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  canvasQueues.set(key, tail);
  void tail.then(() => {
    if (canvasQueues.get(key) === tail) {
      canvasQueues.delete(key);
    }
  });
  return run;
}

/** 读画板数据。改了要写回时，读和写都要在 withCanvasLock 里。 */
export async function readCanvasBoardFile(projectRoot: string): Promise<CanvasBoard> {
  return readBoardFile(projectRoot);
}

/** 写回画板数据并同步修改要求。只能在 withCanvasLock 里调用。 */
export async function writeCanvasBoardFile(projectRoot: string, board: CanvasBoard): Promise<void> {
  await writeBoardFile(projectRoot, board);
}

export function canvasDirectory(projectRoot: string): string {
  return canvasDirLexical(projectRoot);
}

/** 合并重复行之前的原样备份（T11.0d）。只留第一次的，不覆盖。 */
export const CANVAS_BOARD_DEDUPE_BACKUP = "board.before-dedupe.json";

async function readBoardFile(projectRoot: string): Promise<CanvasBoard> {
  const boardPath = join(canvasDirLexical(projectRoot), CANVAS_BOARD_NAME);
  try {
    const text = await readFile(boardPath, "utf8");
    const parsed = parseCanvasBoard(JSON.parse(text) as unknown);
    if (parsed !== undefined) {
      const deduped = dedupeCanvasBoard(parsed);
      if (deduped.removed > 0) {
        // 下一次写画板时按合并后的写回；合并前的原文件先留一份。
        await copyFile(
          boardPath,
          join(canvasDirLexical(projectRoot), CANVAS_BOARD_DEDUPE_BACKUP),
          fsConstants.COPYFILE_EXCL,
        ).catch(() => undefined);
      }
      return deduped.board;
    }
  } catch {
    // fall through
  }
  return defaultCanvasBoard();
}

/** Windows 上目标文件被别的程序（杀毒、索引、看图软件）短暂占着时改名会失败，重试几次。 */
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;

/** 改名，遇到 Windows 的短暂占用就重试。 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !RENAME_RETRY_CODES.has(code)) {
        throw error;
      }
      await new Promise((done) => setTimeout(done, 50 * attempt));
    }
  }
}

/** 先写临时文件再改名。失败时删掉临时文件，不留 `.xxx.tmp`。 */
export async function writeAtomic(target: string, data: Buffer | string): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

const STALE_TEMP = /^\..+\.[0-9a-f-]{36}\.tmp$/i;
export const CANVAS_STALE_TEMP_MS = 10 * 60_000;

/** 每个项目上次清临时文件的时间。目录里几千张图，每次打开画板都列一遍太费（T11.0d）。 */
const lastSweepAt = new Map<string, number>();

/** 清掉以前没写成留下的临时文件（超过 10 分钟的；更新的可能还在写）。同一项目 10 分钟内只清一次。 */
async function sweepStaleTemps(projectRoot: string): Promise<void> {
  const key = resolve(projectRoot).toLowerCase();
  const now = Date.now();
  const last = lastSweepAt.get(key);
  if (last !== undefined && now - last < CANVAS_STALE_TEMP_MS) {
    return;
  }
  lastSweepAt.set(key, now);
  const root = canvasDirLexical(projectRoot);
  for (const dir of [root, join(root, CANVAS_REVISIONS_DIR)]) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!STALE_TEMP.test(name)) {
        continue;
      }
      const path = join(dir, name);
      try {
        if (Date.now() - (await stat(path)).mtimeMs > CANVAS_STALE_TEMP_MS) {
          await unlink(path);
        }
      } catch {
        // 别的程序占着或已经没了，下次再清
      }
    }
  }
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
    const brief = buildCanvasRevisionFile(
      resolved.relative,
      imageFileName,
      items,
      await readImageSize(resolved.absolute),
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

/** 宽高只在文件头里：只读开头一段（JPEG 的尺寸段可能在 EXIF 后面，读 256KB）。T11.0d 以前每次写画板都把每张有标注的图整张读一遍。 */
const IMAGE_HEADER_BYTES = 256 * 1024;

async function readImageSize(
  absolute: string,
): Promise<{ readonly width: number; readonly height: number } | undefined> {
  const handle = await open(absolute, "r");
  try {
    const buffer = Buffer.alloc(IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, IMAGE_HEADER_BYTES, 0);
    return readRasterSize(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function writeBoardFile(projectRoot: string, board: CanvasBoard): Promise<void> {
  const target = join(canvasDirLexical(projectRoot), CANVAS_BOARD_NAME);
  await writeAtomic(target, `${JSON.stringify(board, null, 2)}\n`);
  await syncCanvasRevisions(projectRoot, board);
}

/** 界面打开画板时读：顺带清掉以前留下的临时文件。 */
export async function loadCanvasBoard(projectRoot: string): Promise<CanvasBoard> {
  return withCanvasLock(projectRoot, async () => {
    await sweepStaleTemps(projectRoot);
    return readBoardFile(projectRoot);
  });
}

/** 在锁里读画板、按 change 改、写回。change 返回原对象就不写。 */
export async function editCanvasBoard(
  projectRoot: string,
  change: (board: CanvasBoard) => CanvasBoard,
): Promise<CanvasBoard> {
  return withCanvasLock(projectRoot, async () => {
    const board = await readBoardFile(projectRoot);
    const next = change(board);
    if (next !== board) {
      await writeBoardFile(projectRoot, next);
    }
    return next;
  });
}

export async function placeImageOnBoard(
  projectRoot: string,
  imageRelativePath: string,
  options: { readonly rowId?: string; readonly asNewVersion?: boolean },
): Promise<
  | {
      readonly ok: true;
      readonly board: CanvasBoard;
      readonly relativePath: string;
      /** 这次是不是新放进画板的（已经在画板上、只是挪了行或没动时为 false）。 */
      readonly added: boolean;
    }
  | { readonly ok: false; readonly error: string }
> {
  const resolved = await resolveCanvasImage(projectRoot, imageRelativePath);
  if (!resolved.ok) {
    return resolved;
  }
  return withCanvasLock(projectRoot, async () => {
    let board = await readBoardFile(projectRoot);
    const addedAt = new Date().toISOString();
    const rowId = options.rowId?.trim();
    // 已经在画板上（多半是目录监听先收进来了）：不再加一行。要挂到别的行当新版本时才挪过去。
    const existing = locatePath(board, resolved.relative);
    if (existing !== undefined) {
      const moveTo =
        rowId !== undefined && rowId !== "" && options.asNewVersion && existing.rowId !== rowId
          ? rowId
          : undefined;
      if (moveTo === undefined) {
        return { ok: true as const, board, relativePath: resolved.relative, added: false };
      }
      board = detachVersion(board, resolved.relative);
    }
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
    return {
      ok: true as const,
      board,
      relativePath: resolved.relative,
      added: existing === undefined,
    };
  });
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
  const board = await editCanvasBoard(projectRoot, (current) =>
    removePathFromBoard(current, lexical.relative),
  );
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
  const board = await editCanvasBoard(projectRoot, (current) =>
    setAnnotationsForPath(current, resolved.relative, annotations),
  );
  return { ok: true, board };
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

/** 目录里新出现的图收进画板。返回是否真的加了一行（已经在画板上就不加）。 */
export async function ingestCanvasDirectoryFile(
  projectRoot: string,
  fileName: string,
): Promise<boolean> {
  if (!shouldIngestCanvasFileName(fileName)) {
    return false;
  }
  const relative = `.ffpane/${CANVAS_SUBDIR}/${fileName}`;
  const resolved = await resolveCanvasImage(projectRoot, relative);
  if (!resolved.ok) {
    return false;
  }
  let added = false;
  await editCanvasBoard(projectRoot, (board) => {
    if (locatePath(board, resolved.relative) !== undefined) {
      return board;
    }
    added = true;
    return addImageAsNewRow(
      board,
      resolved.relative,
      `row-${randomUUID()}`,
      new Date().toISOString(),
    );
  });
  return added;
}
