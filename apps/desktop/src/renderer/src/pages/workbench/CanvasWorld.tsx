/**
 * 画板无限画布（T11.0c，Tony 2026-10-27 选的方案）。
 *
 * - 所有图摆在一张画布上：滚轮对着光标缩放，拖空白处平移，拖卡片挪整行，点卡片选中，双击看大图。
 * - 只画落在视口里的行；缩得很小只画色块，放大换 1024 那档图。
 * - 排版、视口、选图档位都在 shared/workbench/canvas-world.ts（纯函数）。
 */

import type { CanvasImageNote, ProjectId } from "@ff-pane/shared";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { projectImageTag } from "../../../../shared/canvas-image-tag";
import { canvasImageUrl } from "../../../../shared/canvas-image-url";
import {
  ARROW_W,
  CARD_H,
  CARD_W,
  centerOnRect,
  DAY_HEADER_H,
  findCard,
  fitWorldView,
  imageTierFor,
  initialWorldView,
  rowsInRect,
  visibleWorldRect,
  type WorldLayout,
} from "../../../../shared/workbench/canvas-world";
import { cn } from "../../lib/cn";
import { type ViewTransform, wheelScaleFactor, zoomAtPoint } from "./canvas-view";

const IMAGE_H = CARD_H - 40;
const MIN_SCALE = 0.02;
const MAX_SCALE = 4;

export interface CanvasWorldProps {
  readonly projectId: ProjectId;
  readonly layout: WorldLayout;
  readonly notes: Readonly<Record<string, CanvasImageNote>>;
  readonly versions: ReadonlyMap<string, string>;
  readonly selectedPath: string | null;
  readonly pendingOnly: boolean;
  readonly isPending: (path: string) => boolean;
  /** 改了就把视口移到这张图（nonce 变就再移一次）。 */
  readonly focus: { readonly path: string; readonly nonce: number } | null;
  /** 改了就看全部。 */
  readonly fitNonce: number;
  readonly onSelect: (path: string | null) => void;
  readonly onOpen: (path: string) => void;
  readonly onPlaceRow: (rowId: string, x: number, y: number) => void;
}

type Gesture =
  | {
      readonly kind: "pan";
      readonly clientX: number;
      readonly clientY: number;
      readonly originX: number;
      readonly originY: number;
      moved: boolean;
    }
  | {
      readonly kind: "row";
      readonly rowId: string;
      readonly path: string;
      readonly clientX: number;
      readonly clientY: number;
      readonly rowX: number;
      readonly rowY: number;
      readonly scale: number;
      moved: boolean;
    };

function clampView(view: ViewTransform): ViewTransform {
  return { ...view, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale)) };
}

/** 缩得很小只画色块：待检查黄、AI 不通过红、不要灰，其余深色。 */
function blockClass(note: CanvasImageNote | undefined): string {
  if (note?.rejected === true) {
    return "bg-border-strong";
  }
  const state = note?.review?.state;
  if (state === "pending") {
    return "bg-warning";
  }
  if (state === "ai-fail") {
    return "bg-danger";
  }
  return "bg-fg-subtle";
}

function stateClass(note: CanvasImageNote | undefined): string {
  const state = note?.review?.state;
  if (note?.rejected === true) {
    return "border-border opacity-60";
  }
  if (state === "pending") {
    return "border-warning";
  }
  if (state === "ai-fail") {
    return "border-danger";
  }
  return "border-border-strong";
}

export function CanvasWorld({
  projectId,
  layout,
  notes,
  versions,
  selectedPath,
  pendingOnly,
  isPending,
  focus,
  fitNonce,
  onSelect,
  onOpen,
  onPlaceRow,
}: CanvasWorldProps): ReactElement {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 24, y: 16 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const gestureRef = useRef<Gesture | null>(null);
  const [drag, setDrag] = useState<{ rowId: string; dx: number; dy: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const placedInitialView = useRef(false);

  // 第一次有了尺寸和排版：最新一天那块铺满视口宽度（换页时组件会按页重建）。
  useEffect(() => {
    if (placedInitialView.current || size.w === 0 || layout.rows.length === 0) {
      return;
    }
    placedInitialView.current = true;
    setView(initialWorldView(layout, size.w));
  }, [layout, size.w]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) {
      return;
    }
    const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      setView((current) =>
        clampView(
          zoomAtPoint(
            current,
            event.clientX - rect.left,
            event.clientY - rect.top,
            current.scale * wheelScaleFactor(event.deltaY),
          ),
        ),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 移到某张图：nonce 变了才移，同一张图连点两次也会再移。
  const focusNonce = focus?.nonce;
  const focusPath = focus?.path;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在请求变化时移动视口，排版或尺寸变化不该把镜头拽回去
  useEffect(() => {
    if (focusPath === undefined || size.w === 0) {
      return;
    }
    const found = findCard(layout.rows, focusPath);
    if (found === undefined) {
      return;
    }
    setView(
      clampView(
        centerOnRect(
          { x: found.card.x, y: found.card.y, w: CARD_W, h: CARD_H },
          size.w,
          size.h,
          viewRef.current.scale,
        ),
      ),
    );
  }, [focusNonce, focusPath]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在按了「看全部」时缩放
  useEffect(() => {
    if (fitNonce === 0 || size.w === 0) {
      return;
    }
    setView(clampView(fitWorldView(layout.bounds, size.w, size.h)));
  }, [fitNonce]);

  const visible = rowsInRect(layout.rows, visibleWorldRect(view, size.w, size.h));
  const tier = imageTierFor(view.scale, window.devicePixelRatio);
  const worldTop = -view.y / view.scale;
  const worldBottom = worldTop + size.h / view.scale;

  const finish = (clientX: number, clientY: number): void => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setGrabbing(false);
    if (gesture === null) {
      return;
    }
    if (gesture.kind === "pan") {
      if (!gesture.moved) {
        onSelect(null);
      }
      return;
    }
    setDrag(null);
    if (!gesture.moved) {
      onSelect(gesture.path);
      return;
    }
    onPlaceRow(
      gesture.rowId,
      gesture.rowX + (clientX - gesture.clientX) / gesture.scale,
      gesture.rowY + (clientY - gesture.clientY) / gesture.scale,
    );
  };

  const move = (clientX: number, clientY: number): void => {
    const gesture = gestureRef.current;
    if (gesture === null) {
      return;
    }
    const dx = clientX - gesture.clientX;
    const dy = clientY - gesture.clientY;
    if (!gesture.moved && dx * dx + dy * dy < 16) {
      return;
    }
    gesture.moved = true;
    setGrabbing(true);
    if (gesture.kind === "pan") {
      setView((current) => ({ ...current, x: gesture.originX + dx, y: gesture.originY + dy }));
      return;
    }
    setDrag({ rowId: gesture.rowId, dx: dx / gesture.scale, dy: dy / gesture.scale });
  };

  return (
    <div
      ref={containerRef}
      data-testid="canvas-world"
      className={cn(
        "relative min-h-0 flex-1 touch-none overflow-hidden bg-surface-sunken",
        grabbing ? "cursor-grabbing" : "cursor-grab",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0 && event.button !== 1) {
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        gestureRef.current = {
          kind: "pan",
          clientX: event.clientX,
          clientY: event.clientY,
          originX: viewRef.current.x,
          originY: viewRef.current.y,
          moved: false,
        };
      }}
      onPointerMove={(event) => move(event.clientX, event.clientY)}
      onPointerUp={(event) => finish(event.clientX, event.clientY)}
      onPointerCancel={() => {
        gestureRef.current = null;
        setGrabbing(false);
        setDrag(null);
      }}
    >
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transformOrigin: "0 0",
        }}
      >
        {visible.map((row) => {
          const offset =
            drag !== null && drag.rowId === row.id ? { dx: drag.dx, dy: drag.dy } : null;
          return (
            <div
              key={row.id}
              className={cn("absolute", offset !== null ? "z-10 opacity-90" : "")}
              style={{
                left: row.x + (offset?.dx ?? 0),
                top: row.y + (offset?.dy ?? 0),
                width: row.w,
                height: row.h,
              }}
            >
              {tier === "none"
                ? row.cards.map((card) => (
                    <button
                      key={card.path}
                      type="button"
                      aria-label={projectImageTag(card.path).fileName}
                      data-path={card.path}
                      className={cn(
                        "absolute rounded-md",
                        blockClass(notes[card.path]),
                        card.path === selectedPath ? "ring-8 ring-primary" : "",
                        pendingOnly && !isPending(card.path) ? "opacity-25" : "",
                      )}
                      style={{ left: card.x - row.x, top: 0, width: CARD_W, height: CARD_H }}
                      onPointerDown={(event) => {
                        if (event.button !== 0) {
                          return;
                        }
                        event.stopPropagation();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        gestureRef.current = {
                          kind: "row",
                          rowId: row.id,
                          path: card.path,
                          clientX: event.clientX,
                          clientY: event.clientY,
                          rowX: row.x,
                          rowY: row.y,
                          scale: viewRef.current.scale,
                          moved: false,
                        };
                      }}
                      onPointerMove={(event) => move(event.clientX, event.clientY)}
                      onPointerUp={(event) => {
                        event.stopPropagation();
                        finish(event.clientX, event.clientY);
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        onOpen(card.path);
                      }}
                    />
                  ))
                : row.cards.map((card) => {
                    const note = notes[card.path];
                    const tag = projectImageTag(card.path);
                    const selected = card.path === selectedPath;
                    const dimmed = pendingOnly && !isPending(card.path);
                    const version = versions.get(card.path);
                    const flag =
                      note?.deleteRequest !== undefined
                        ? t("workbench.canvas.flagRequest")
                        : note?.rejected === true
                          ? t("workbench.canvas.flagRejected")
                          : null;
                    return (
                      <div key={card.path}>
                        {card.index > 0 ? (
                          <div
                            aria-hidden="true"
                            className="absolute flex items-center"
                            style={{
                              left: card.x - row.x - ARROW_W,
                              top: IMAGE_H / 2,
                              width: ARROW_W,
                            }}
                          >
                            <div className="h-1 w-full bg-primary" />
                          </div>
                        ) : null}
                        <button
                          type="button"
                          title={tag.label}
                          data-testid="canvas-card"
                          data-path={card.path}
                          className={cn(
                            "absolute flex flex-col overflow-hidden rounded-md border-4 bg-surface text-left shadow-sm",
                            stateClass(note),
                            selected ? "ring-4 ring-primary" : "",
                            dimmed ? "opacity-25" : "",
                          )}
                          style={{ left: card.x - row.x, top: 0, width: CARD_W, height: CARD_H }}
                          onPointerDown={(event) => {
                            if (event.button !== 0) {
                              return;
                            }
                            event.stopPropagation();
                            event.currentTarget.setPointerCapture(event.pointerId);
                            gestureRef.current = {
                              kind: "row",
                              rowId: row.id,
                              path: card.path,
                              clientX: event.clientX,
                              clientY: event.clientY,
                              rowX: row.x,
                              rowY: row.y,
                              scale: viewRef.current.scale,
                              moved: false,
                            };
                          }}
                          onPointerMove={(event) => move(event.clientX, event.clientY)}
                          onPointerUp={(event) => {
                            event.stopPropagation();
                            finish(event.clientX, event.clientY);
                          }}
                          onDoubleClick={(event) => {
                            event.stopPropagation();
                            onOpen(card.path);
                          }}
                        >
                          <span
                            className="relative flex items-center justify-center bg-surface-sunken"
                            style={{ height: IMAGE_H }}
                          >
                            <img
                              src={canvasImageUrl(projectId, card.path, "thumb", version)}
                              alt=""
                              decoding="async"
                              draggable={false}
                              className="max-h-full max-w-full object-contain"
                            />
                            {tier === "large" ? (
                              <img
                                src={canvasImageUrl(projectId, card.path, "large", version)}
                                alt=""
                                decoding="async"
                                draggable={false}
                                className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
                              />
                            ) : null}
                            {note?.review?.state === "pending" ? (
                              <span
                                className="absolute right-1 top-1 h-3 w-3 rounded-full bg-warning"
                                data-testid="canvas-pending-dot"
                              />
                            ) : null}
                            {note?.review?.state === "ai-pass" ? (
                              <span className="absolute bottom-1 right-1 rounded-sm bg-success px-1 text-[11px] text-success-fg">
                                {t("workbench.canvas.aiPassMark")}
                              </span>
                            ) : null}
                            {note?.review?.state === "ai-fail" ? (
                              <span className="absolute bottom-1 right-1 rounded-sm bg-danger px-1 text-[11px] text-danger-fg">
                                {t("workbench.canvas.aiFailMark")}
                              </span>
                            ) : null}
                            {flag !== null ? (
                              <span
                                className="absolute left-1 top-1 rounded-sm bg-warning-surface px-1 text-[11px] text-warning-text"
                                data-testid="canvas-image-flag"
                              >
                                {flag}
                              </span>
                            ) : null}
                          </span>
                          <span className="flex min-h-0 flex-1 flex-col justify-center border-t border-border-strong bg-surface-raised px-2 text-fg">
                            <span className="block truncate text-[13px] font-medium leading-tight">
                              {tag.fileName}
                            </span>
                            <span className="block truncate text-[11px] leading-tight text-fg-muted">
                              {tag.path}
                            </span>
                          </span>
                        </button>
                      </div>
                    );
                  })}
            </div>
          );
        })}
      </div>
      {/* 日期块的标题画在屏幕坐标里，不跟着缩放，缩到看全部时也认得出哪块是哪天。 */}
      {layout.headers
        .filter((header) => header.y + DAY_HEADER_H >= worldTop && header.y <= worldBottom)
        .map((header) => (
          <div
            key={header.day}
            className="pointer-events-none absolute whitespace-nowrap rounded-sm bg-surface/80 px-1.5 text-base font-semibold text-fg-muted"
            style={{
              left: Math.max(4, view.x + header.x * view.scale),
              top: view.y + (header.y + DAY_HEADER_H) * view.scale - 30,
            }}
          >
            {t("workbench.canvas.dayHeader", { day: header.day.slice(5), count: header.count })}
          </div>
        ))}
    </div>
  );
}
