/**
 * 画板无限画布的排版（T11.0c）。纯函数，不碰 React，单测直接测。
 *
 * - 一个版本行是一条：同一行的版本从左往右，中间留箭头的位置。
 * - 没拖过的行按天分块自动排：最新的一天在最上面，块里最新的在前，从左到右流式排。
 *   一行放几张按这一天的张数定（块大致 16:10，6–60 张），「看全部」时整个画板是一片，不是细长条。
 * - 拖过的行留在拖到的位置（board.placements），自动排时绕开它们。
 * - 单位是画布像素；视口用 canvas-view.ts 的 { scale, x, y }。
 */

export const CARD_W = 240;
export const CARD_H = 210;
export const ARROW_W = 40;
export const GAP_X = 32;
export const GAP_Y = 40;
export const MIN_LINE_CARDS = 6;
export const MAX_LINE_CARDS = 60;
/** 一个日块大致的宽高比。 */
const DAY_BLOCK_ASPECT = 1.6;

/** 这一天有 n 张图时一行放几张。 */
export function lineCardsFor(cardCount: number): number {
  const ideal = Math.round(
    Math.sqrt(Math.max(1, cardCount) * DAY_BLOCK_ASPECT * (CARD_H / CARD_W)),
  );
  return Math.min(MAX_LINE_CARDS, Math.max(MIN_LINE_CARDS, ideal));
}

export function lineMaxWidth(cards: number): number {
  return cards * CARD_W + (cards - 1) * GAP_X;
}
export const DAY_HEADER_H = 56;
export const DAY_GAP = 72;

export interface WorldVersionInput {
  readonly path: string;
  readonly addedAt: string;
}

export interface WorldRowInput {
  readonly id: string;
  readonly versions: readonly WorldVersionInput[];
}

export interface WorldRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface WorldCard {
  readonly path: string;
  readonly rowId: string;
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

export interface WorldRow extends WorldRect {
  readonly id: string;
  readonly placed: boolean;
  readonly cards: readonly WorldCard[];
}

export interface WorldHeader {
  readonly day: string;
  readonly count: number;
  readonly x: number;
  readonly y: number;
  /** 这一块一行的宽度（打开画板时按最新一块的宽度缩放）。 */
  readonly width: number;
}

export interface WorldLayout {
  readonly rows: readonly WorldRow[];
  readonly headers: readonly WorldHeader[];
  readonly bounds: WorldRect;
  /** 所有图按画面上的阅读顺序（从上到下、从左到右）。 */
  readonly order: readonly string[];
}

export function rowWidth(versionCount: number): number {
  const n = Math.max(1, versionCount);
  return n * CARD_W + (n - 1) * ARROW_W;
}

/** 本地日期 YYYY-MM-DD。 */
export function localDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "0000-00-00";
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function intersects(a: WorldRect, b: WorldRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function inflate(rect: WorldRect, by: number): WorldRect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

function cardsOf(row: WorldRowInput, x: number, y: number): WorldCard[] {
  return row.versions.map((version, index) => ({
    path: version.path,
    rowId: row.id,
    index,
    x: x + index * (CARD_W + ARROW_W),
    y,
  }));
}

function firstAddedAt(row: WorldRowInput): string {
  return row.versions[0]?.addedAt ?? "";
}

export function layoutWorld(
  rows: readonly WorldRowInput[],
  placements: Readonly<Record<string, { readonly x: number; readonly y: number }>> = {},
  dayKey: (iso: string) => string = localDayKey,
): WorldLayout {
  const out: WorldRow[] = [];
  const placedRects: WorldRect[] = [];
  const auto: WorldRowInput[] = [];
  for (const row of rows) {
    if (row.versions.length === 0) {
      continue;
    }
    const placement = placements[row.id];
    if (placement === undefined) {
      auto.push(row);
      continue;
    }
    const rect = { x: placement.x, y: placement.y, w: rowWidth(row.versions.length), h: CARD_H };
    placedRects.push(rect);
    out.push({ ...rect, id: row.id, placed: true, cards: cardsOf(row, rect.x, rect.y) });
  }

  // 按天分块，最新的一天在上；块里最新的在前。
  const byDay = new Map<string, WorldRowInput[]>();
  for (const row of auto) {
    const key = dayKey(firstAddedAt(row));
    const list = byDay.get(key);
    if (list === undefined) {
      byDay.set(key, [row]);
    } else {
      list.push(row);
    }
  }
  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
  const headers: WorldHeader[] = [];
  let y = 0;
  for (const day of days) {
    const group = (byDay.get(day) ?? [])
      .slice()
      .sort((a, b) => firstAddedAt(b).localeCompare(firstAddedAt(a)));
    const lineW = lineMaxWidth(
      lineCardsFor(group.reduce((sum, row) => sum + row.versions.length, 0)),
    );
    headers.push({ day, count: group.length, x: 0, y, width: lineW });
    y += DAY_HEADER_H;
    let lineX = 0;
    let lineY = y;
    for (const row of group) {
      const w = rowWidth(row.versions.length);
      for (let guard = 0; guard < 100_000; guard += 1) {
        if (lineX > 0 && lineX + w > lineW) {
          lineX = 0;
          lineY += CARD_H + GAP_Y;
        }
        const rect = { x: lineX, y: lineY, w, h: CARD_H };
        const hit = placedRects.find((placed) => intersects(inflate(rect, GAP_X / 2), placed));
        if (hit === undefined) {
          break;
        }
        lineX = hit.x + hit.w + GAP_X;
        if (lineX <= 0) {
          lineX = 1;
        }
      }
      out.push({
        x: lineX,
        y: lineY,
        w,
        h: CARD_H,
        id: row.id,
        placed: false,
        cards: cardsOf(row, lineX, lineY),
      });
      lineX += w + GAP_X;
    }
    y = lineY + CARD_H + DAY_GAP;
  }

  const rects: WorldRect[] = [
    ...out,
    ...headers.map((header) => ({ x: header.x, y: header.y, w: 200, h: DAY_HEADER_H })),
  ];
  const bounds =
    rects.length === 0
      ? { x: 0, y: 0, w: 0, h: 0 }
      : (() => {
          const minX = Math.min(...rects.map((r) => r.x));
          const minY = Math.min(...rects.map((r) => r.y));
          const maxX = Math.max(...rects.map((r) => r.x + r.w));
          const maxY = Math.max(...rects.map((r) => r.y + r.h));
          return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        })();
  const order = out
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .flatMap((row) => row.cards.map((card) => card.path));
  return { rows: out, headers, bounds, order };
}

/** 视口在画布上看到的范围。 */
export function visibleWorldRect(
  view: { readonly scale: number; readonly x: number; readonly y: number },
  width: number,
  height: number,
): WorldRect {
  const scale = view.scale > 0 ? view.scale : 1;
  return { x: -view.x / scale, y: -view.y / scale, w: width / scale, h: height / scale };
}

/** 落在范围里（外加一圈余量）的行。 */
export function rowsInRect(
  rows: readonly WorldRow[],
  rect: WorldRect,
  margin = CARD_W,
): readonly WorldRow[] {
  const area = inflate(rect, margin);
  return rows.filter((row) => intersects(row, area));
}

export type CanvasImageTier = "none" | "thumb" | "large";

/** 缩得很小只画色块；放大到缩略图不够清楚时换 1024 那档。 */
export function imageTierFor(scale: number, devicePixelRatio = 1): CanvasImageTier {
  const css = CARD_W * scale;
  if (css < 36) {
    return "none";
  }
  return css * Math.max(1, devicePixelRatio) > 384 ? "large" : "thumb";
}

/** 看全部：整个画布缩进视口并留白。 */
export function fitWorldView(
  bounds: WorldRect,
  width: number,
  height: number,
  padding = 48,
): { readonly scale: number; readonly x: number; readonly y: number } {
  if (bounds.w <= 0 || bounds.h <= 0 || width < 8 || height < 8) {
    return { scale: 1, x: padding, y: padding };
  }
  const scale = Math.min(
    1,
    Math.max(0.02, Math.min((width - padding * 2) / bounds.w, (height - padding * 2) / bounds.h)),
  );
  return {
    scale,
    x: (width - bounds.w * scale) / 2 - bounds.x * scale,
    y: Math.max(padding, (height - bounds.h * scale) / 2) - bounds.y * scale,
  };
}

/** 打开画板时的视口：最新一天那块的宽度正好铺满视口（缩放 0.3–1），从左上角看起。 */
export function initialWorldView(
  layout: WorldLayout,
  width: number,
  padding = 24,
): { readonly scale: number; readonly x: number; readonly y: number } {
  const first = layout.headers[0];
  const blockWidth = first?.width ?? CARD_W;
  const scale = Math.min(1, Math.max(0.3, (width - padding * 2) / blockWidth));
  return { scale, x: padding, y: padding - (first?.y ?? 0) * scale };
}

/** 把画布上的一块移到视口正中（缩放不变；太小就放大到 minScale）。 */
export function centerOnRect(
  rect: WorldRect,
  width: number,
  height: number,
  scale: number,
  minScale = 0.6,
): { readonly scale: number; readonly x: number; readonly y: number } {
  const next = Math.max(scale, minScale);
  return {
    scale: next,
    x: width / 2 - (rect.x + rect.w / 2) * next,
    y: height / 2 - (rect.y + rect.h / 2) * next,
  };
}

/** 按顺序找下一张（或上一张）满足条件的，从 current 之后开始、到头了从头接着找。 */
export function nextInOrder(
  order: readonly string[],
  current: string | null,
  matches: (path: string) => boolean,
  direction: 1 | -1 = 1,
): string | undefined {
  if (order.length === 0) {
    return undefined;
  }
  const start = current === null ? -1 : order.indexOf(current);
  for (let step = 1; step <= order.length; step += 1) {
    const index = (((start + direction * step) % order.length) + order.length) % order.length;
    const path = order[index];
    if (path !== undefined && path !== current && matches(path)) {
      return path;
    }
  }
  return undefined;
}

export function findCard(
  rows: readonly WorldRow[],
  path: string,
): { readonly row: WorldRow; readonly card: WorldCard } | undefined {
  for (const row of rows) {
    const card = row.cards.find((item) => item.path === path);
    if (card !== undefined) {
      return { row, card };
    }
  }
  return undefined;
}
