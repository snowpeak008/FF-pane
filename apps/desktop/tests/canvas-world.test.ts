/**
 * T11.0c：画板无限画布排版、视口、找下一张。
 */

import { describe, expect, it } from "vitest";
import {
  ARROW_W,
  CARD_H,
  CARD_W,
  centerOnRect,
  DAY_HEADER_H,
  findCard,
  fitWorldView,
  GAP_X,
  imageTierFor,
  intersects,
  layoutWorld,
  lineCardsFor,
  lineMaxWidth,
  nextInOrder,
  rowsInRect,
  rowWidth,
  visibleWorldRect,
} from "../src/shared/workbench/canvas-world";

const day = (iso: string): string => iso.slice(0, 10);

function row(id: string, at: string, n = 1) {
  return {
    id,
    versions: Array.from({ length: n }, (_, index) => ({
      path: `${id}-${index}.png`,
      addedAt: at,
    })),
  };
}

describe("layoutWorld", () => {
  it("按天分块，最新的一天在上，块里最新的在前", () => {
    const layout = layoutWorld(
      [
        row("old", "2026-10-25T01:00:00Z"),
        row("a", "2026-10-27T01:00:00Z"),
        row("b", "2026-10-27T05:00:00Z"),
      ],
      {},
      day,
    );
    expect(layout.headers.map((h) => [h.day, h.count])).toEqual([
      ["2026-10-27", 2],
      ["2026-10-25", 1],
    ]);
    const b = layout.rows.find((r) => r.id === "b");
    const a = layout.rows.find((r) => r.id === "a");
    expect(b?.x).toBe(0);
    expect(b?.y).toBe(DAY_HEADER_H);
    expect(a?.x).toBe(CARD_W + GAP_X);
    const old = layout.rows.find((r) => r.id === "old");
    expect(old?.y).toBeGreaterThan((a?.y ?? 0) + CARD_H);
    expect(layout.order.slice(0, 3)).toEqual(["b-0.png", "a-0.png", "old-0.png"]);
  });

  it("一行满了换行；版本从左往右排，中间留箭头", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row(`r${i}`, `2026-10-27T${String(10 + i).padStart(2, "0")}:00:00Z`),
    );
    rows.push(row("chain", "2026-10-27T00:00:00Z", 3));
    const layout = layoutWorld(rows, {}, day);
    const lineW = lineMaxWidth(lineCardsFor(13));
    for (const item of layout.rows) {
      expect(item.x + item.w <= lineW || item.x === 0).toBe(true);
    }
    const lines = new Set(layout.rows.map((r) => r.y));
    expect(lines.size).toBeGreaterThan(1);
    const chain = layout.rows.find((r) => r.id === "chain");
    expect(chain?.w).toBe(rowWidth(3));
    expect(chain?.cards.map((c) => c.x - (chain?.x ?? 0))).toEqual([
      0,
      CARD_W + ARROW_W,
      2 * (CARD_W + ARROW_W),
    ]);
  });

  it("拖过的行留在原处，自动排的绕开它，谁也不压谁", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row(`r${i}`, `2026-10-27T${String(10 + i).padStart(2, "0")}:00:00Z`),
    );
    const layout = layoutWorld(rows, { r3: { x: 300, y: DAY_HEADER_H + 10 } }, day);
    const placed = layout.rows.find((r) => r.id === "r3");
    expect(placed).toMatchObject({ x: 300, y: DAY_HEADER_H + 10, placed: true });
    for (const a of layout.rows) {
      for (const b of layout.rows) {
        if (a.id !== b.id) {
          expect(intersects(a, b)).toBe(false);
        }
      }
    }
  });

  it("一行放几张跟着当天张数走：少的 6 张起，多的到 60 张为止；整个画板不是细长条", () => {
    expect(lineCardsFor(3)).toBe(6);
    expect(lineCardsFor(400)).toBeGreaterThan(15);
    expect(lineCardsFor(100_000)).toBe(60);
    const rows = Array.from({ length: 3000 }, (_, i) => row(`r${i}`, "2026-10-25T00:00:00Z"));
    const layout = layoutWorld(rows, {}, day);
    expect(layout.bounds.h / layout.bounds.w).toBeLessThan(1.5);
    expect(layout.headers[0]?.width).toBe(lineMaxWidth(lineCardsFor(3000)));
  });

  it("空画板", () => {
    const layout = layoutWorld([], {}, day);
    expect(layout.rows).toEqual([]);
    expect(layout.bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("4000 行排得快", () => {
    const rows = Array.from({ length: 4000 }, (_, i) =>
      row(`r${i}`, new Date(Date.UTC(2026, 9, 20 + (i % 7), 0, i % 60)).toISOString()),
    );
    const started = performance.now();
    const layout = layoutWorld(rows, { r10: { x: 5000, y: 5000 } }, day);
    expect(layout.rows).toHaveLength(4000);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("视口", () => {
  it("只取看得见的行", () => {
    const layout = layoutWorld(
      Array.from({ length: 50 }, (_, i) => row(`r${i}`, "2026-10-27T00:00:00Z")),
      {},
      day,
    );
    const rect = visibleWorldRect({ scale: 1, x: 0, y: 0 }, 800, 600);
    const shown = rowsInRect(layout.rows, rect, 0);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(layout.rows.length);
  });

  it("按缩放选图：很小只画色块，放大换大图", () => {
    expect(imageTierFor(0.1)).toBe("none");
    expect(imageTierFor(1)).toBe("thumb");
    expect(imageTierFor(2)).toBe("large");
    expect(imageTierFor(1, 2)).toBe("large");
  });

  it("看全部把整块缩进视口；移到某块时它在正中", () => {
    const view = fitWorldView({ x: 0, y: 0, w: 4000, h: 2000 }, 1000, 600);
    expect(view.scale).toBeLessThan(1);
    expect(4000 * view.scale).toBeLessThanOrEqual(1000);
    const centered = centerOnRect({ x: 1000, y: 1000, w: 240, h: 210 }, 1000, 600, 1);
    expect(centered.x + (1000 + 120) * centered.scale).toBeCloseTo(500);
    expect(centered.y + (1000 + 105) * centered.scale).toBeCloseTo(300);
  });
});

describe("找图", () => {
  it("下一张、上一张、到头从头接着找，跳过不符合的", () => {
    const order = ["a", "b", "c", "d"];
    const pending = new Set(["b", "d"]);
    expect(nextInOrder(order, null, (p) => pending.has(p))).toBe("b");
    expect(nextInOrder(order, "b", (p) => pending.has(p))).toBe("d");
    expect(nextInOrder(order, "d", (p) => pending.has(p))).toBe("b");
    expect(nextInOrder(order, "b", (p) => pending.has(p), -1)).toBe("d");
    expect(nextInOrder(order, "a", () => false)).toBeUndefined();
  });

  it("按路径找到卡片", () => {
    const layout = layoutWorld([row("x", "2026-10-27T00:00:00Z", 2)], {}, day);
    expect(findCard(layout.rows, "x-1.png")?.card.index).toBe(1);
    expect(findCard(layout.rows, "nope.png")).toBeUndefined();
  });
});
