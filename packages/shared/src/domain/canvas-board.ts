/**
 * 项目画板 board.json（T10.21）。数据只落在 `<项目>/.ffpane/canvas/`。
 */

export const CANVAS_BOARD_VERSION = 1 as const;

export const CANVAS_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;

export type CanvasAnnotationKind = "rect" | "label" | "text";

export interface CanvasAnnotation {
  readonly id: string;
  readonly kind: CanvasAnnotationKind;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: string;
  readonly text?: string;
  readonly label?: string;
}

export interface CanvasVersion {
  readonly path: string;
  readonly addedAt: string;
}

export interface CanvasRow {
  readonly id: string;
  readonly versions: readonly CanvasVersion[];
  readonly hidden?: boolean;
}

export interface CanvasPage {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly CanvasRow[];
}

/** AI 窗口申请删一张图（T11.0）：没被用户标「不要」的图不直接删，等用户同意。 */
export interface CanvasDeleteRequest {
  /** 申请的窗口标题。 */
  readonly by: string;
  readonly reason: string;
  readonly at: string;
}

/** 画板上一张图的附注（T11.0）。 */
export interface CanvasImageNote {
  /** 用户标了「不要」：AI 删它会直接进回收站。 */
  readonly rejected?: boolean;
  readonly deleteRequest?: CanvasDeleteRequest;
  /** 导出到项目里的哪些位置（项目内相对路径）。 */
  readonly exportedTo?: readonly string[];
}

export interface CanvasBoard {
  readonly v: typeof CANVAS_BOARD_VERSION;
  readonly pages: readonly CanvasPage[];
  readonly annotations: Readonly<Record<string, readonly CanvasAnnotation[]>>;
  readonly activePageId?: string;
  readonly notes?: Readonly<Record<string, CanvasImageNote>>;
}

export function defaultCanvasBoard(): CanvasBoard {
  const pageId = "page-1";
  return {
    v: CANVAS_BOARD_VERSION,
    pages: [{ id: pageId, title: "1", rows: [] }],
    annotations: {},
    activePageId: pageId,
  };
}

export function isCanvasImageFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return CANVAS_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function activePage(board: CanvasBoard): CanvasPage {
  const id = board.activePageId ?? board.pages[0]?.id;
  const found = board.pages.find((page) => page.id === id);
  return found ?? board.pages[0] ?? { id: "page-1", title: "1", rows: [] };
}

export function setActivePage(board: CanvasBoard, pageId: string): CanvasBoard {
  if (!board.pages.some((page) => page.id === pageId)) {
    return board;
  }
  return { ...board, activePageId: pageId };
}

export function addCanvasPage(board: CanvasBoard, title: string, id: string): CanvasBoard {
  return {
    ...board,
    pages: [...board.pages, { id, title, rows: [] }],
    activePageId: id,
  };
}

/** 新图默认新开一行（竖向排布）。 */
export function addImageAsNewRow(
  board: CanvasBoard,
  imagePath: string,
  rowId: string,
  addedAt: string,
): CanvasBoard {
  const page = activePage(board);
  const pageIndex = board.pages.findIndex((item) => item.id === page.id);
  if (pageIndex < 0) {
    return board;
  }
  const rows = [...page.rows, { id: rowId, versions: [{ path: imagePath, addedAt }] }];
  return {
    ...board,
    pages: board.pages.map((item, index) => (index === pageIndex ? { ...item, rows } : item)),
  };
}

/** 同一行追加新版本（横向排布）。 */
export function appendVersionToRow(
  board: CanvasBoard,
  rowId: string,
  imagePath: string,
  addedAt: string,
): CanvasBoard {
  const page = activePage(board);
  const pageIndex = board.pages.findIndex((item) => item.id === page.id);
  if (pageIndex < 0) {
    return board;
  }
  let found = false;
  const rows = page.rows.map((row) => {
    if (row.id !== rowId) {
      return row;
    }
    found = true;
    if (row.versions.some((version) => version.path === imagePath)) {
      return row;
    }
    return {
      ...row,
      versions: [...row.versions, { path: imagePath, addedAt }],
    };
  });
  if (!found) {
    return board;
  }
  return {
    ...board,
    pages: board.pages.map((item, index) => (index === pageIndex ? { ...item, rows } : item)),
  };
}

/** 从画板移除路径（不删磁盘文件）。hidden 行仍保留结构时可整行隐藏。 */
export function removePathFromBoard(board: CanvasBoard, imagePath: string): CanvasBoard {
  const { [imagePath]: _removed, ...rest } = board.annotations;
  const { [imagePath]: _note, ...notes } = board.notes ?? {};
  return {
    ...withNotes(board, notes),
    pages: board.pages.map((page) => ({
      ...page,
      rows: page.rows
        .map((row) => ({
          ...row,
          versions: row.versions.filter((version) => version.path !== imagePath),
        }))
        .filter((row) => row.versions.length > 0),
    })),
    annotations: rest,
  };
}

function withNotes(
  board: CanvasBoard,
  notes: Readonly<Record<string, CanvasImageNote>>,
): CanvasBoard {
  const { notes: _old, ...rest } = board;
  return Object.keys(notes).length > 0 ? { ...rest, notes } : rest;
}

/** 改一张图的附注；改完是空的就整条去掉。 */
export function setImageNote(
  board: CanvasBoard,
  imagePath: string,
  change: (note: CanvasImageNote) => CanvasImageNote,
): CanvasBoard {
  const { [imagePath]: before, ...others } = board.notes ?? {};
  const next = change(before ?? {});
  const kept: CanvasImageNote = {
    ...(next.rejected === true ? { rejected: true } : {}),
    ...(next.deleteRequest !== undefined ? { deleteRequest: next.deleteRequest } : {}),
    ...(next.exportedTo !== undefined && next.exportedTo.length > 0
      ? { exportedTo: next.exportedTo }
      : {}),
  };
  return withNotes(board, Object.keys(kept).length > 0 ? { ...others, [imagePath]: kept } : others);
}

/** 图在哪一页哪一行。 */
export function locatePath(
  board: CanvasBoard,
  imagePath: string,
): { readonly pageId: string; readonly rowId: string } | undefined {
  for (const page of board.pages) {
    for (const row of page.rows) {
      if (row.versions.some((version) => version.path === imagePath)) {
        return { pageId: page.id, rowId: row.id };
      }
    }
  }
  return undefined;
}

/**
 * 把图放回原来的页和行（从回收站恢复）。行没了放到那一页末尾，页也没了放到当前页末尾。
 * 已经在画板上就不动。
 */
export function placePathAt(
  board: CanvasBoard,
  imagePath: string,
  at: { readonly pageId?: string; readonly rowId?: string },
  newRowId: string,
  addedAt: string,
): CanvasBoard {
  if (locatePath(board, imagePath) !== undefined) {
    return board;
  }
  const page = board.pages.find((item) => item.id === at.pageId) ?? activePage(board);
  const hasRow = at.rowId !== undefined && page.rows.some((row) => row.id === at.rowId);
  const rows = hasRow
    ? page.rows.map((row) =>
        row.id === at.rowId
          ? { ...row, versions: [...row.versions, { path: imagePath, addedAt }] }
          : row,
      )
    : [...page.rows, { id: newRowId, versions: [{ path: imagePath, addedAt }] }];
  return {
    ...board,
    pages: board.pages.map((item) => (item.id === page.id ? { ...item, rows } : item)),
  };
}

export function setAnnotationsForPath(
  board: CanvasBoard,
  imagePath: string,
  items: readonly CanvasAnnotation[],
): CanvasBoard {
  return {
    ...board,
    annotations: { ...board.annotations, [imagePath]: [...items] },
  };
}

export function findRowForPath(board: CanvasBoard, imagePath: string): CanvasRow | undefined {
  for (const page of board.pages) {
    for (const row of page.rows) {
      if (row.versions.some((version) => version.path === imagePath)) {
        return row;
      }
    }
  }
  return undefined;
}

export function parseCanvasBoard(raw: unknown): CanvasBoard | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record["v"] !== CANVAS_BOARD_VERSION) {
    return undefined;
  }
  const pagesRaw = record["pages"];
  if (!Array.isArray(pagesRaw)) {
    return undefined;
  }
  const pages: CanvasPage[] = [];
  for (const pageRaw of pagesRaw) {
    if (typeof pageRaw !== "object" || pageRaw === null) {
      continue;
    }
    const page = pageRaw as Record<string, unknown>;
    const id = page["id"];
    const title = page["title"];
    const rowsRaw = page["rows"];
    if (typeof id !== "string" || typeof title !== "string" || !Array.isArray(rowsRaw)) {
      continue;
    }
    const rows: CanvasRow[] = [];
    for (const rowRaw of rowsRaw) {
      if (typeof rowRaw !== "object" || rowRaw === null) {
        continue;
      }
      const row = rowRaw as Record<string, unknown>;
      const rowId = row["id"];
      const versionsRaw = row["versions"];
      if (typeof rowId !== "string" || !Array.isArray(versionsRaw)) {
        continue;
      }
      const versions: CanvasVersion[] = [];
      for (const versionRaw of versionsRaw) {
        if (typeof versionRaw !== "object" || versionRaw === null) {
          continue;
        }
        const version = versionRaw as Record<string, unknown>;
        const path = version["path"];
        const addedAt = version["addedAt"];
        if (typeof path === "string" && typeof addedAt === "string") {
          versions.push({ path, addedAt });
        }
      }
      if (versions.length > 0) {
        rows.push({
          id: rowId,
          versions,
          ...(row["hidden"] === true ? { hidden: true } : {}),
        });
      }
    }
    pages.push({ id, title, rows });
  }
  if (pages.length === 0) {
    return undefined;
  }
  const annotationsRaw = record["annotations"];
  const annotations: Record<string, CanvasAnnotation[]> = {};
  if (typeof annotationsRaw === "object" && annotationsRaw !== null) {
    for (const [key, value] of Object.entries(annotationsRaw)) {
      if (!Array.isArray(value)) {
        continue;
      }
      const items: CanvasAnnotation[] = [];
      for (const itemRaw of value) {
        if (typeof itemRaw !== "object" || itemRaw === null) {
          continue;
        }
        const item = itemRaw as Record<string, unknown>;
        const kind = item["kind"];
        const id = item["id"];
        const x = item["x"];
        const y = item["y"];
        const w = item["w"];
        const h = item["h"];
        const color = item["color"];
        if (
          (kind === "rect" || kind === "label" || kind === "text") &&
          typeof id === "string" &&
          typeof x === "number" &&
          typeof y === "number" &&
          typeof w === "number" &&
          typeof h === "number" &&
          typeof color === "string"
        ) {
          items.push({
            id,
            kind,
            x,
            y,
            w,
            h,
            color,
            ...(typeof item["text"] === "string" ? { text: item["text"] } : {}),
            ...(typeof item["label"] === "string" ? { label: item["label"] } : {}),
          });
        }
      }
      if (items.length > 0) {
        annotations[key] = items;
      }
    }
  }
  const activePageId =
    typeof record["activePageId"] === "string" ? record["activePageId"] : pages[0]?.id;
  const notes = parseNotes(record["notes"]);
  return {
    v: CANVAS_BOARD_VERSION,
    pages,
    annotations,
    ...(activePageId !== undefined ? { activePageId } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

function parseNotes(raw: unknown): Record<string, CanvasImageNote> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const notes: Record<string, CanvasImageNote> = {};
  for (const [path, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const item = value as Record<string, unknown>;
    const request = item["deleteRequest"] as Record<string, unknown> | undefined;
    const exportedTo = Array.isArray(item["exportedTo"])
      ? item["exportedTo"].filter((entry): entry is string => typeof entry === "string")
      : [];
    const note: CanvasImageNote = {
      ...(item["rejected"] === true ? { rejected: true } : {}),
      ...(typeof request === "object" &&
      request !== null &&
      typeof request["by"] === "string" &&
      typeof request["reason"] === "string" &&
      typeof request["at"] === "string"
        ? { deleteRequest: { by: request["by"], reason: request["reason"], at: request["at"] } }
        : {}),
      ...(exportedTo.length > 0 ? { exportedTo } : {}),
    };
    if (Object.keys(note).length > 0) {
      notes[path] = note;
    }
  }
  return Object.keys(notes).length > 0 ? notes : undefined;
}
