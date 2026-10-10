/**
 * 项目画板：缩略图条、整图查看。拖动空白移动画面，点一下打标签。
 */

import type { CanvasAnnotation, CanvasBoard, ProjectId } from "@ff-pane/shared";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { projectImageTag } from "../../../../shared/canvas-image-tag";
import type { WorkbenchCanvasBoardView } from "../../../../shared-ipc/contracts";
import { Button } from "../../components/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/Tabs";
import { invokeQuery } from "../../ipc/query";
import { useSubscription } from "../../ipc/useSubscription";
import { useWorkbenchCanvasStore } from "../../stores/workbench-canvas";
import { renderCanvasMarkedPng } from "./canvas-marked-preview";
import {
  clampImagePoint,
  draggedImagePoint,
  fitImageView,
  imagePointFromScreen,
  isInsideImage,
  screenPointFromImage,
  type ViewTransform,
  wheelScaleFactor,
  zoomAtPoint,
} from "./canvas-view";

const ANNOTATION_COLORS = ["#ef4444", "#22c55e", "#3b82f6", "#eab308", "#a855f7"] as const;

function boardFromView(view: WorkbenchCanvasBoardView): CanvasBoard {
  return view;
}

function viewFromBoard(board: CanvasBoard): WorkbenchCanvasBoardView {
  return board;
}

function CanvasImage({
  projectId,
  path,
  selected,
  onSelect,
}: {
  readonly projectId: ProjectId;
  readonly path: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void invokeQuery("workbench:read-canvas-image", { projectId, relativePath: path }).then(
      (settled) => {
        if (cancelled) {
          return;
        }
        if (settled.status === "error") {
          return;
        }
        setSrc(settled.data.dataUrl);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  const tag = projectImageTag(path);
  return (
    <button
      type="button"
      onClick={onSelect}
      title={tag.label}
      className={`flex h-28 w-36 shrink-0 flex-col overflow-hidden rounded-md border-2 bg-bg text-left shadow-sm ${
        selected ? "border-primary ring-2 ring-primary/40" : "border-neutral-800"
      }`}
    >
      <span className="flex min-h-0 flex-1 items-center justify-center bg-muted/40 p-1">
        {src === null ? (
          <span className="text-xs text-fg-muted">…</span>
        ) : (
          <img
            src={src}
            alt=""
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        )}
      </span>
      <span className="border-t-2 border-neutral-800 bg-neutral-900 px-1.5 py-1 text-white">
        <span className="block truncate text-[10px] leading-tight">
          {t("workbench.canvas.projectTag")}
        </span>
        <span className="block truncate text-[11px] font-medium leading-tight">{tag.fileName}</span>
        <span className="block truncate text-[10px] leading-tight text-white/70">{tag.path}</span>
      </span>
    </button>
  );
}

function Viewer({
  projectId,
  path,
  annotations,
  onAnnotationsCommit,
}: {
  readonly projectId: ProjectId;
  readonly path: string;
  readonly annotations: readonly CanvasAnnotation[];
  readonly onAnnotationsCommit: (
    next: readonly CanvasAnnotation[],
    preview: Promise<string | null>,
  ) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(null);
  const srcPath = useRef(path);
  if (srcPath.current !== path) {
    srcPath.current = path;
    setSrc(null);
  }
  const paintedPath = useRef<string | null>(null);
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 });
  const imageSizeRef = useRef({ w: 0, h: 0 });
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const userMoved = useRef(false);
  const suppressPlaceRef = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [draft, setDraft] = useState<{ id: string; x: number; y: number } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const gestureRef = useRef<
    | {
        readonly kind: "canvas";
        readonly clientX: number;
        readonly clientY: number;
        readonly originX: number;
        readonly originY: number;
        readonly button: number;
        moved: boolean;
      }
    | {
        readonly kind: "move";
        readonly id: string;
        readonly clientX: number;
        readonly clientY: number;
        readonly originX: number;
        readonly originY: number;
        readonly scale: number;
        moved: boolean;
      }
    | null
  >(null);
  const [color, setColor] = useState<string>(ANNOTATION_COLORS[0]);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const skipBlurRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editRef = useRef<HTMLInputElement | null>(null);

  const fitNow = useCallback((): void => {
    const el = containerRef.current;
    const size = imageSizeRef.current;
    if (el === null) {
      return;
    }
    const next = fitImageView(el.clientWidth, el.clientHeight, size.w, size.h);
    if (next !== undefined) {
      setView(next);
    }
  }, []);

  useEffect(() => {
    userMoved.current = false;
    setView({ scale: 1, x: 0, y: 0 });
    imageSizeRef.current = { w: 0, h: 0 };
    setImageSize({ w: 0, h: 0 });
    setDraft(null);
    draftRef.current = null;
    gestureRef.current = null;
    let cancelled = false;
    void invokeQuery("workbench:read-canvas-image", { projectId, relativePath: path }).then(
      (settled) => {
        if (cancelled) {
          return;
        }
        if (settled.status === "error") {
          toast.error(settled.error.message);
          return;
        }
        setSrc(settled.data.dataUrl);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (!userMoved.current) {
        fitNow();
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [fitNow]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      userMoved.current = true;
      setView((current) =>
        zoomAtPoint(
          current,
          event.clientX - rect.left,
          event.clientY - rect.top,
          current.scale * wheelScaleFactor(event.deltaY),
        ),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    if (editing === null) {
      return;
    }
    editRef.current?.focus();
  }, [editing]);

  const publish = useCallback(
    (next: readonly CanvasAnnotation[]): void => {
      const preview =
        next.length === 0 || src === null
          ? Promise.resolve(null)
          : renderCanvasMarkedPng(src, next, path);
      onAnnotationsCommit(next, preview);
    },
    [onAnnotationsCommit, path, src],
  );

  useEffect(() => {
    if (src === null || annotations.length === 0 || paintedPath.current === path) {
      return;
    }
    paintedPath.current = path;
    publish(annotations);
  }, [annotations, path, publish, src]);

  const commitEditing = (): void => {
    if (editing === null || skipBlurRef.current) {
      return;
    }
    const value = editing.value.trim();
    publish(
      value === ""
        ? annotations.filter((item) => item.id !== editing.id)
        : annotations.map((item) => (item.id === editing.id ? { ...item, text: value } : item)),
    );
    setEditing(null);
  };

  const applyColor = (next: string): void => {
    setColor(next);
    if (selectedId === null) {
      return;
    }
    publish(annotations.map((item) => (item.id === selectedId ? { ...item, color: next } : item)));
  };

  const deleteBubble = useCallback(
    (id: string): void => {
      skipBlurRef.current = true;
      publish(annotations.filter((item) => item.id !== id));
      setSelectedId((current) => (current === id ? null : current));
      setEditing((current) => (current?.id === id ? null : current));
    },
    [annotations, publish],
  );

  const deleteSelected = useCallback((): void => {
    if (selectedId === null) {
      return;
    }
    deleteBubble(selectedId);
  }, [deleteBubble, selectedId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (editing !== null || selectedId === null) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }
      event.preventDefault();
      deleteSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [deleteSelected, editing, selectedId]);

  const beginEdit = (id: string, value: string): void => {
    skipBlurRef.current = true;
    setEditing({ id, value });
    window.setTimeout(() => {
      skipBlurRef.current = false;
      editRef.current?.focus();
    }, 0);
  };

  const shownAnnotations = annotations.map((item) =>
    draft !== null && draft.id === item.id ? { ...item, x: draft.x, y: draft.y } : item,
  );

  const placeBubble = (x: number, y: number): void => {
    const point = clampImagePoint(x, y, imageSize.w, imageSize.h);
    const item: CanvasAnnotation = {
      id: crypto.randomUUID(),
      kind: "label",
      x: point.x,
      y: point.y,
      w: 0,
      h: 0,
      color,
      label: String(annotations.filter((entry) => entry.kind === "label").length + 1),
    };
    publish([...annotations, item]);
    setSelectedId(item.id);
    beginEdit(item.id, "");
  };

  const localPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = containerRef.current;
    if (el === null) {
      return null;
    }
    const rect = el.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const finishGesture = (clientX: number, clientY: number, editText = false): void => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setGrabbing(false);
    if (gesture === null) {
      return;
    }
    if (gesture.kind === "canvas") {
      const place = !gesture.moved && gesture.button === 0 && !suppressPlaceRef.current;
      suppressPlaceRef.current = false;
      if (!place) {
        return;
      }
      const local = localPoint(clientX, clientY);
      if (local === null) {
        return;
      }
      const point = imagePointFromScreen(viewRef.current, local.x, local.y);
      const size = imageSizeRef.current;
      if (!isInsideImage(point.x, point.y, size.w, size.h)) {
        setSelectedId(null);
        return;
      }
      placeBubble(point.x, point.y);
      return;
    }
    if (gesture.moved) {
      const point = draggedImagePoint(
        gesture.originX,
        gesture.originY,
        gesture.clientX,
        gesture.clientY,
        clientX,
        clientY,
        gesture.scale,
        imageSize.w,
        imageSize.h,
      );
      const next = { id: gesture.id, x: point.x, y: point.y };
      draftRef.current = next;
      setDraft(next);
      publish(
        annotations.map((item) =>
          item.id === gesture.id ? { ...item, x: point.x, y: point.y } : item,
        ),
      );
      return;
    }
    draftRef.current = null;
    setDraft(null);
    if (editText) {
      const current = annotations.find((item) => item.id === gesture.id);
      beginEdit(gesture.id, current?.text ?? "");
    }
  };

  const moveGesture = (clientX: number, clientY: number): void => {
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
    if (gesture.kind === "canvas") {
      userMoved.current = true;
      setGrabbing(true);
      setView((current) => ({
        ...current,
        x: gesture.originX + (clientX - gesture.clientX),
        y: gesture.originY + (clientY - gesture.clientY),
      }));
      return;
    }
    const point = draggedImagePoint(
      gesture.originX,
      gesture.originY,
      gesture.clientX,
      gesture.clientY,
      clientX,
      clientY,
      gesture.scale,
      imageSize.w,
      imageSize.h,
    );
    const next = { id: gesture.id, x: point.x, y: point.y };
    draftRef.current = next;
    setDraft(next);
  };

  useEffect(() => {
    const current = draftRef.current;
    if (current === null) {
      return;
    }
    const item = annotations.find((entry) => entry.id === current.id);
    const synced =
      item !== undefined &&
      Math.abs(item.x - current.x) < 0.5 &&
      Math.abs(item.y - current.y) < 0.5;
    if (item === undefined || synced) {
      draftRef.current = null;
      setDraft(null);
    }
  }, [annotations]);

  const editingItem = shownAnnotations.find((item) => item.id === editing?.id);
  const editingScreen =
    editingItem === undefined ? null : screenPointFromImage(view, editingItem.x, editingItem.y);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {ANNOTATION_COLORS.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={value}
            className={`h-5 w-5 rounded-full border ${color === value ? "ring-2 ring-primary" : ""}`}
            style={{ backgroundColor: value }}
            onClick={() => applyColor(value)}
          />
        ))}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            userMoved.current = false;
            fitNow();
          }}
        >
          {t("workbench.canvas.fit")}
        </Button>
        <span className="text-fg-muted">{t("workbench.canvas.dragHint")}</span>
      </div>
      <div
        ref={containerRef}
        className={`relative min-h-0 flex-1 touch-none overflow-hidden rounded border border-border bg-muted/40 ${
          grabbing ? "cursor-grabbing" : "cursor-grab"
        }`}
        onPointerDown={(event) => {
          if (event.button !== 0 && event.button !== 1) {
            return;
          }
          if (editing !== null) {
            suppressPlaceRef.current = true;
          }
          const current = viewRef.current;
          gestureRef.current = {
            kind: "canvas",
            clientX: event.clientX,
            clientY: event.clientY,
            originX: current.x,
            originY: current.y,
            button: event.button,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          moveGesture(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          finishGesture(event.clientX, event.clientY);
        }}
        onPointerCancel={() => {
          gestureRef.current = null;
          suppressPlaceRef.current = false;
          setGrabbing(false);
          draftRef.current = null;
          setDraft(null);
        }}
      >
        <div
          className="absolute left-0 top-0"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: "0 0",
          }}
        >
          {src !== null ? (
            <img
              src={src}
              alt=""
              className="max-w-none select-none shadow-sm"
              draggable={false}
              onLoad={(event) => {
                const size = {
                  w: event.currentTarget.naturalWidth,
                  h: event.currentTarget.naturalHeight,
                };
                imageSizeRef.current = size;
                setImageSize(size);
                if (!userMoved.current) {
                  fitNow();
                }
              }}
            />
          ) : null}
        </div>
        {shownAnnotations.map((item) => {
          if (item.kind !== "label") {
            return null;
          }
          const number =
            shownAnnotations
              .filter((entry) => entry.kind === "label")
              .findIndex((entry) => entry.id === item.id) + 1;
          const screen = screenPointFromImage(view, item.x, item.y);
          const text = item.text?.trim() ?? "";
          const selected = selectedId === item.id;
          return (
            <div
              key={item.id}
              className="absolute z-10 cursor-grab"
              style={{ left: screen.x, top: screen.y }}
              onPointerDown={(event) => {
                if (event.button !== 0) {
                  return;
                }
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                gestureRef.current = {
                  kind: "move",
                  id: item.id,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  originX: item.x,
                  originY: item.y,
                  scale: viewRef.current.scale,
                  moved: false,
                };
                setSelectedId(item.id);
              }}
              onPointerMove={(event) => {
                moveGesture(event.clientX, event.clientY);
              }}
              onPointerUp={(event) => {
                const target = event.target;
                const editText =
                  target instanceof Element && target.closest("[data-bubble-text]") !== null;
                finishGesture(event.clientX, event.clientY, editText);
              }}
            >
              <div
                className={`absolute flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white shadow ${
                  selected ? "ring-2 ring-neutral-900" : ""
                }`}
                style={{
                  transform: "translate(-50%, -50%)",
                  backgroundColor: item.color,
                }}
              >
                {number}
              </div>
              {text !== "" && editing?.id !== item.id ? (
                <div
                  data-bubble-text=""
                  className="absolute left-4 max-w-56 -translate-y-1/2 cursor-text rounded-full bg-white/95 px-2 py-0.5 text-sm leading-tight shadow"
                  style={{ color: item.color }}
                >
                  {text}
                </div>
              ) : null}
              {selected ? (
                <button
                  type="button"
                  aria-label={t("workbench.canvas.deleteTag")}
                  className="absolute left-2 top-[-18px] z-20 flex h-4 w-4 items-center justify-center rounded-full bg-neutral-900 text-[10px] leading-none text-white"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteBubble(item.id);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
        {editing !== null && editingScreen !== null ? (
          <input
            ref={editRef}
            className="absolute z-20 min-w-28 rounded-full border bg-white px-2 py-0.5 text-sm shadow"
            style={{
              left: editingScreen.x + 18,
              top: editingScreen.y,
              transform: "translateY(-50%)",
              color: editingItem?.color ?? color,
              borderColor: editingItem?.color ?? color,
            }}
            placeholder={t("workbench.canvas.textPlaceholder")}
            value={editing.value}
            onChange={(event) => {
              setEditing({ ...editing, value: event.target.value });
            }}
            onBlur={commitEditing}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitEditing();
              }
              if (event.key === "Escape") {
                const current = annotations.find((item) => item.id === editing.id);
                if ((current?.text ?? "") === "" && editing.value.trim() === "") {
                  publish(annotations.filter((item) => item.id !== editing.id));
                }
                setEditing(null);
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
          />
        ) : null}
      </div>
    </div>
  );
}

export function WorkbenchCanvasPanel({
  projectId,
}: {
  readonly projectId: ProjectId;
}): ReactElement | null {
  const { t } = useTranslation();
  const open = useWorkbenchCanvasStore((s) => s.open);
  const focusPath = useWorkbenchCanvasStore((s) => s.focusPath);
  const closeCanvas = useWorkbenchCanvasStore((s) => s.closeCanvas);
  const setFocusPath = useWorkbenchCanvasStore((s) => s.setFocusPath);
  const [board, setBoard] = useState<CanvasBoard | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const settled = await invokeQuery("workbench:get-canvas", { projectId });
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return;
    }
    const next = boardFromView(settled.data.board);
    setBoard(next);
    setSelectedPath((current) => {
      if (current !== null) {
        return current;
      }
      const page = next.pages.find((item) => item.id === next.activePageId) ?? next.pages[0];
      return page?.rows[0]?.versions[0]?.path ?? null;
    });
  }, [projectId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void reload();
  }, [open, reload]);

  useSubscription("workbench:canvas-changed", (payload) => {
    if (payload.projectId !== projectId || !open) {
      return;
    }
    void reload();
  });

  useEffect(() => {
    if (focusPath !== null) {
      setSelectedPath(focusPath);
      setFocusPath(null);
    }
  }, [focusPath, setFocusPath]);

  const activePageId = board?.activePageId ?? board?.pages[0]?.id ?? "page-1";

  const commitChain = useRef(Promise.resolve());

  const persistBoard = async (next: CanvasBoard): Promise<boolean> => {
    setBoard(next);
    const settled = await invokeQuery("workbench:save-canvas", {
      projectId,
      board: viewFromBoard(next),
    });
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return false;
    }
    return true;
  };

  const saveMarkedPreview = async (path: string, pngBase64: string): Promise<void> => {
    const settled = await invokeQuery("workbench:save-canvas-marked", {
      projectId,
      relativePath: path,
      pngBase64,
    });
    if (settled.status === "error") {
      toast.error(settled.error.message);
    }
  };

  const removeFromBoard = async (): Promise<void> => {
    if (selectedPath === null) {
      return;
    }
    const settled = await invokeQuery("workbench:remove-canvas-image", {
      projectId,
      relativePath: selectedPath,
    });
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return;
    }
    setBoard(boardFromView(settled.data.board));
    setSelectedPath(null);
    toast.message(t("workbench.canvas.removedFromBoard"));
  };

  if (!open || board === null) {
    return null;
  }

  const annotations = selectedPath !== null ? (board.annotations[selectedPath] ?? []) : [];

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-bg/95 backdrop-blur-sm"
      role="dialog"
      aria-label={t("workbench.canvas.title")}
    >
      <header className="flex items-center border-b border-border px-3 py-2 pr-14">
        <h2 className="text-sm font-medium">{t("workbench.canvas.title")}</h2>
      </header>
      <button
        type="button"
        aria-label={t("workbench.canvas.close")}
        className="absolute right-3 top-3 z-50 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-bg text-lg leading-none shadow-sm"
        onClick={closeCanvas}
      >
        ×
      </button>
      <Tabs
        value={activePageId}
        onValueChange={(value) => {
          void persistBoard({ ...board, activePageId: value });
        }}
        className="flex shrink-0 flex-col px-3"
      >
        <TabsList>
          {board.pages.map((page) => (
            <TabsTrigger key={page.id} value={page.id}>
              {page.title}
            </TabsTrigger>
          ))}
        </TabsList>
        {board.pages.map((page) => (
          <TabsContent key={page.id} value={page.id} className="flex-none max-h-64 overflow-y-auto">
            {page.rows.length === 0 ? (
              <p className="py-2 text-xs text-fg-muted">{t("workbench.canvas.empty")}</p>
            ) : (
              <div className="flex flex-col gap-3 py-2">
                {page.rows.map((row) => (
                  <div key={row.id} className="flex items-center overflow-x-auto pb-2">
                    {row.versions.map((version, index) => (
                      <div key={version.path} className="flex shrink-0 items-center">
                        {index > 0 ? (
                          <div className="flex h-28 w-8 items-center" aria-hidden="true">
                            <div className="h-0.5 w-full bg-primary" />
                          </div>
                        ) : null}
                        <CanvasImage
                          projectId={projectId}
                          path={version.path}
                          selected={selectedPath === version.path}
                          onSelect={() => setSelectedPath(version.path)}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
      {selectedPath !== null ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border px-3 pb-3 pt-2">
          <div className="mb-2 flex items-center justify-between gap-3 rounded-md border-2 border-neutral-800 bg-neutral-900 px-2 py-1.5 text-white">
            <div className="min-w-0">
              <p className="text-[10px] leading-tight text-white/70">
                {t("workbench.canvas.projectTag")}
              </p>
              <p className="truncate text-xs font-medium">
                {projectImageTag(selectedPath).fileName}
              </p>
              <p className="truncate text-[11px] text-white/70">
                {projectImageTag(selectedPath).path}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void removeFromBoard()}
              >
                {t("workbench.canvas.removeFromBoard")}
              </Button>
            </div>
          </div>
          <Viewer
            projectId={projectId}
            path={selectedPath}
            annotations={annotations}
            onAnnotationsCommit={(next, preview) => {
              const path = selectedPath;
              commitChain.current = commitChain.current
                .then(async () => {
                  const saved = await persistBoard({
                    ...board,
                    annotations: { ...board.annotations, [path]: next },
                  });
                  if (!saved || next.length === 0) {
                    return;
                  }
                  const png = await preview;
                  if (png === null) {
                    return;
                  }
                  await saveMarkedPreview(path, png);
                })
                .catch(() => undefined);
            }}
          />
        </div>
      ) : (
        <p className="border-t border-border px-3 py-2 text-xs text-fg-muted">
          {t("workbench.canvas.pickImage")}
        </p>
      )}
    </div>
  );
}
