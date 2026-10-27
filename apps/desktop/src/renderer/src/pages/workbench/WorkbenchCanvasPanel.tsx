/**
 * 项目画板（T11.0c 起是无限画布）：所有图摆在一张画布上，按天分块；新图待检查，Tony 或 AI 检查。
 * 画板是项目图库（T11.0）：删图进回收站；可以标「不要」；AI 的删图申请在这里同意或保留；
 * 彻底删除、清空回收站只有这里能做。
 * 图片走 `ffpane-canvas://`（T11.0d）：缩略图懒加载、主进程缓存，原图只在大图里取。
 */

import type { CanvasBoard, ProjectId } from "@ff-pane/shared";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { projectImageTag } from "../../../../shared/canvas-image-tag";
import { needsTonyReview } from "../../../../shared/workbench/canvas-review";
import { layoutWorld, nextInOrder } from "../../../../shared/workbench/canvas-world";
import type {
  WorkbenchCanvasBoardView,
  WorkbenchCanvasEdit,
  WorkbenchCanvasTrashEntryView,
  WorkbenchGetCanvasResponse,
} from "../../../../shared-ipc/contracts";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { invokeQuery } from "../../ipc/query";
import { useSubscription } from "../../ipc/useSubscription";
import { cn } from "../../lib/cn";
import { useWorkbenchCanvasStore } from "../../stores/workbench-canvas";
import { CanvasViewer } from "./CanvasViewer";
import { CanvasWorld } from "./CanvasWorld";

function boardFromView(view: WorkbenchCanvasBoardView): CanvasBoard {
  return view;
}

/** 画板里每个路径最近一次放进来的时间，当图片地址的版本号用（同一路径换了图会重新取）。 */
function versionsByPath(board: CanvasBoard): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const page of board.pages) {
    for (const row of page.rows) {
      for (const version of row.versions) {
        out.set(version.path, version.addedAt);
      }
    }
  }
  return out;
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
  const setViewerOpen = useWorkbenchCanvasStore((s) => s.setViewerOpen);
  const [board, setBoard] = useState<CanvasBoard | null>(null);
  const [trash, setTrash] = useState<readonly WorkbenchCanvasTrashEntryView[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [purging, setPurging] = useState<{ readonly trashId?: string } | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  /** 大图里「上一张 / 下一张」只在待检查的图里走（从待检查的图打开时）。 */
  const [viewerPendingOnly, setViewerPendingOnly] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [focus, setFocus] = useState<{ path: string; nonce: number } | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const [search, setSearch] = useState("");

  const adopt = (data: WorkbenchGetCanvasResponse): CanvasBoard => {
    const next = boardFromView(data.board);
    setBoard(next);
    setTrash(data.trash);
    return next;
  };

  /** 改画板的一处。主进程只改这一处，不整份覆盖。 */
  const applyEdit = async (edit: WorkbenchCanvasEdit): Promise<boolean> => {
    const settled = await invokeQuery("workbench:canvas-edit", { projectId, edit });
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return false;
    }
    adopt(settled.data);
    return true;
  };

  const reload = useCallback(async () => {
    const settled = await invokeQuery("workbench:get-canvas", { projectId });
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return;
    }
    setBoard(boardFromView(settled.data.board));
    setTrash(settled.data.trash);
  }, [projectId]);

  useEffect(() => {
    if (!open) {
      setViewerPath(null);
      return;
    }
    void reload();
  }, [open, reload]);

  useEffect(() => {
    setViewerOpen(viewerPath !== null);
  }, [setViewerOpen, viewerPath]);

  useSubscription("workbench:canvas-changed", (payload) => {
    if (payload.projectId !== projectId || !open) {
      return;
    }
    void reload();
  });

  const jumpTo = (path: string): void => {
    setSelectedPath(path);
    setFocus((current) => ({ path, nonce: (current?.nonce ?? 0) + 1 }));
  };

  useEffect(() => {
    if (focusPath !== null) {
      setSelectedPath(focusPath);
      setFocus((current) => ({ path: focusPath, nonce: (current?.nonce ?? 0) + 1 }));
      setFocusPath(null);
    }
  }, [focusPath, setFocusPath]);

  const activePageId = board?.activePageId ?? board?.pages[0]?.id ?? "page-1";
  const activePage = board?.pages.find((page) => page.id === activePageId) ?? board?.pages[0];
  const placements = board?.placements;
  const layout = useMemo(
    () => layoutWorld(activePage?.rows ?? [], placements ?? {}),
    [activePage, placements],
  );
  const versions = useMemo(
    () => (board === null ? new Map<string, string>() : versionsByPath(board)),
    [board],
  );
  const notes = board?.notes ?? {};
  const isPending = (path: string): boolean => needsTonyReview(notes[path]);
  const pendingCount = layout.order.filter(isPending).length;

  const commitChain = useRef(Promise.resolve());

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

  const removeFromBoard = async (path: string): Promise<void> => {
    const settled = await invokeQuery("workbench:remove-canvas-image", {
      projectId,
      relativePath: path,
    });
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return;
    }
    adopt(settled.data);
    setSelectedPath(null);
    toast.message(t("workbench.canvas.removedFromBoard"));
  };

  const trashImage = async (path: string): Promise<void> => {
    if (await applyEdit({ kind: "trash", path })) {
      setSelectedPath(null);
      toast.message(t("workbench.canvas.trashed"));
    }
  };

  /** 打开大图：待检查的图看过就算已看。 */
  const openViewer = (path: string, pendingQueue: boolean): void => {
    setSelectedPath(path);
    setViewerPath(path);
    setViewerPendingOnly(pendingQueue);
    if (needsTonyReview(notes[path])) {
      void applyEdit({ kind: "review", path, state: "seen" });
    }
  };

  const stepViewer = (direction: 1 | -1): void => {
    if (viewerPath === null) {
      return;
    }
    const next = nextInOrder(
      layout.order,
      viewerPath,
      viewerPendingOnly ? isPending : () => true,
      direction,
    );
    if (next === undefined) {
      toast.message(t("workbench.canvas.noMorePending"));
      return;
    }
    openViewer(next, viewerPendingOnly);
    jumpTo(next);
  };

  const nextPending = (): void => {
    const next = nextInOrder(layout.order, selectedPath, isPending);
    if (next === undefined) {
      toast.message(t("workbench.canvas.noMorePending"));
      return;
    }
    jumpTo(next);
  };

  const runSearch = (): void => {
    const text = search.trim().toLowerCase();
    if (text === "") {
      return;
    }
    const found = nextInOrder(layout.order, selectedPath, (path) =>
      path.toLowerCase().includes(text),
    );
    if (found === undefined) {
      toast.message(t("workbench.canvas.searchNone", { text: search.trim() }));
      return;
    }
    jumpTo(found);
  };

  // 大图开着时：Esc 关大图（不关画板），← / → 上一张 / 下一张。
  useEffect(() => {
    if (viewerPath === null) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setViewerPath(null);
      } else if (event.key === "ArrowRight") {
        stepViewer(1);
      } else if (event.key === "ArrowLeft") {
        stepViewer(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open || board === null) {
    return null;
  }

  const selectedNote = selectedPath !== null ? notes[selectedPath] : undefined;
  const selectedRow =
    selectedPath === null
      ? undefined
      : layout.rows.find((row) => row.cards.some((card) => card.path === selectedPath));
  const viewerVersion = viewerPath !== null ? versions.get(viewerPath) : undefined;

  const reviewLabel = (path: string): string => {
    const review = notes[path]?.review;
    switch (review?.state) {
      case "pending":
        return t("workbench.canvas.reviewPending");
      case "ai-pass":
        return t("workbench.canvas.reviewAiPass", {
          by: review.by ?? "",
          reason: review.reason ?? "",
        });
      case "ai-fail":
        return t("workbench.canvas.reviewAiFail", {
          by: review.by ?? "",
          reason: review.reason ?? "",
        });
      default:
        return t("workbench.canvas.reviewSeen");
    }
  };

  const reviewButton = (path: string): ReactElement =>
    needsTonyReview(notes[path]) ? (
      <Button
        type="button"
        size="sm"
        variant="secondary"
        data-testid="canvas-mark-seen"
        onClick={() => void applyEdit({ kind: "review", path, state: "seen" })}
      >
        {t("workbench.canvas.markSeen")}
      </Button>
    ) : (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-testid="canvas-reopen"
        onClick={() => void applyEdit({ kind: "review", path, state: "pending" })}
      >
        {notes[path]?.review?.state === "ai-pass"
          ? t("workbench.canvas.reopenAiPass")
          : t("workbench.canvas.reopen")}
      </Button>
    );

  const rejectButton = (path: string): ReactElement => (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      data-testid="canvas-mark-rejected"
      onClick={() =>
        void applyEdit({ kind: "mark-rejected", path, rejected: notes[path]?.rejected !== true })
      }
    >
      {notes[path]?.rejected === true
        ? t("workbench.canvas.unmarkRejected")
        : t("workbench.canvas.markRejected")}
    </Button>
  );

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-surface-sunken"
      role="dialog"
      aria-label={t("workbench.canvas.title")}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 pr-14">
        <h2 className="text-sm font-medium">{t("workbench.canvas.title")}</h2>
        {board.pages.length > 1
          ? board.pages.map((page) => (
              <Button
                key={page.id}
                type="button"
                size="sm"
                variant={page.id === activePageId ? "secondary" : "ghost"}
                onClick={() => {
                  setBoard({ ...board, activePageId: page.id });
                  void applyEdit({ kind: "set-page", pageId: page.id });
                }}
              >
                {page.title}
              </Button>
            ))
          : null}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="canvas-fit"
          onClick={() => setFitNonce((value) => value + 1)}
        >
          {t("workbench.canvas.fitAll")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="canvas-next-pending"
          disabled={pendingCount === 0}
          onClick={nextPending}
        >
          {t("workbench.canvas.nextPending", { count: pendingCount })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={pendingOnly ? "primary" : "ghost"}
          data-testid="canvas-pending-only"
          aria-pressed={pendingOnly}
          onClick={() => setPendingOnly((value) => !value)}
        >
          {t("workbench.canvas.pendingOnly")}
        </Button>
        <input
          className="h-8 w-48 rounded-md border border-border bg-surface px-2 text-sm"
          placeholder={t("workbench.canvas.searchPlaceholder")}
          data-testid="canvas-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              runSearch();
            }
          }}
        />
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="canvas-trash-toggle"
          onClick={() => setShowTrash((value) => !value)}
        >
          {t("workbench.canvas.trash", { count: trash.length })}
        </Button>
      </header>
      {showTrash ? (
        <div
          className="flex max-h-72 shrink-0 flex-col gap-1 overflow-y-auto border-b border-border bg-surface px-3 py-2 text-xs"
          data-testid="canvas-trash"
        >
          {trash.length === 0 ? (
            <p className="text-fg-muted">{t("workbench.canvas.trashEmpty")}</p>
          ) : (
            <>
              {trash.map((entry) => (
                <div key={entry.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {t("workbench.canvas.trashEntry", {
                      name: projectImageTag(entry.originalPath).fileName,
                      by: entry.deletedBy,
                      at: new Date(entry.deletedAt).toLocaleString(),
                    })}
                    {entry.reason !== undefined
                      ? t("workbench.canvas.trashReason", { reason: entry.reason })
                      : ""}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void applyEdit({ kind: "restore", trashId: entry.id })}
                  >
                    {t("workbench.canvas.restore")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setPurging({ trashId: entry.id })}
                  >
                    {t("workbench.canvas.purge")}
                  </Button>
                </div>
              ))}
              <div className="pt-1">
                <Button type="button" size="sm" variant="ghost" onClick={() => setPurging({})}>
                  {t("workbench.canvas.purgeAll")}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
      <ConfirmDialog
        open={purging !== null}
        onOpenChange={(value) => {
          if (!value) {
            setPurging(null);
          }
        }}
        title={
          purging?.trashId === undefined
            ? t("workbench.canvas.purgeAllTitle", { count: trash.length })
            : t("workbench.canvas.purgeTitle")
        }
        description={t("workbench.canvas.purgeDescription")}
        confirmLabel={t("workbench.canvas.purge")}
        onConfirm={() => {
          const target = purging;
          setPurging(null);
          if (target !== null) {
            void applyEdit({
              kind: "purge",
              ...(target.trashId !== undefined ? { trashId: target.trashId } : {}),
            });
          }
        }}
      />
      <button
        type="button"
        aria-label={t("workbench.canvas.close")}
        className="absolute right-3 top-2 z-50 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-lg leading-none shadow-sm"
        onClick={closeCanvas}
      >
        ×
      </button>
      {/* 选中条一直占着位置（没选时是提示），选中一张图时画布不会被挤得跳一下。 */}
      {viewerPath === null ? (
        selectedPath === null ? (
          <div
            className="flex h-24 shrink-0 items-center border-b-2 border-border-strong bg-surface-raised px-3 text-sm text-fg-muted"
            data-testid="canvas-selection-empty"
          >
            {t("workbench.canvas.selectHint")}
          </div>
        ) : (
          <div
            className="flex h-24 shrink-0 items-center gap-3 overflow-hidden border-b-2 border-border-strong bg-surface-raised px-3 text-fg"
            data-testid="canvas-selection"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {projectImageTag(selectedPath).fileName}
              </p>
              <p className="truncate text-[11px] text-fg-muted">{selectedPath}</p>
              <p
                className={cn(
                  "truncate text-xs",
                  needsTonyReview(selectedNote) ? "text-warning" : "text-fg-muted",
                )}
                data-testid="canvas-review-state"
              >
                {reviewLabel(selectedPath)}
              </p>
              {selectedNote?.exportedTo !== undefined ? (
                <p className="truncate text-[11px] text-fg-muted" data-testid="canvas-exported-to">
                  {t("workbench.canvas.exportedTo", { paths: selectedNote.exportedTo.join(", ") })}
                </p>
              ) : null}
            </div>
            <div className="flex max-h-full min-w-0 flex-wrap content-center items-center justify-end gap-2">
              {selectedNote?.deleteRequest !== undefined ? (
                <div
                  className="flex items-center gap-2 rounded-md bg-warning-surface px-2 py-1.5 text-xs text-warning-text"
                  data-testid="canvas-delete-request"
                >
                  <span className="max-w-80">
                    {t("workbench.canvas.deleteRequest", {
                      by: selectedNote.deleteRequest.by,
                      reason: selectedNote.deleteRequest.reason,
                    })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void applyEdit({ kind: "resolve-request", path: selectedPath, approve: true })
                    }
                  >
                    {t("workbench.canvas.approveDelete")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void applyEdit({
                        kind: "resolve-request",
                        path: selectedPath,
                        approve: false,
                      })
                    }
                  >
                    {t("workbench.canvas.keepImage")}
                  </Button>
                </div>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="primary"
                data-testid="canvas-open-viewer"
                onClick={() => openViewer(selectedPath, needsTonyReview(selectedNote))}
              >
                {t("workbench.canvas.openLarge")}
              </Button>
              {reviewButton(selectedPath)}
              {rejectButton(selectedPath)}
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid="canvas-trash-image"
                onClick={() => void trashImage(selectedPath)}
              >
                {t("workbench.canvas.moveToTrash")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void removeFromBoard(selectedPath)}
              >
                {t("workbench.canvas.removeFromBoard")}
              </Button>
              {selectedRow?.placed === true ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const { [selectedRow.id]: _drop, ...rest } = board.placements ?? {};
                    setBoard({ ...board, placements: rest });
                    void applyEdit({ kind: "place-row", rowId: selectedRow.id, placement: null });
                  }}
                >
                  {t("workbench.canvas.unplaceRow")}
                </Button>
              ) : null}
            </div>
          </div>
        )
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {layout.rows.length === 0 ? (
          <p className="px-3 py-4 text-sm text-fg-muted">{t("workbench.canvas.empty")}</p>
        ) : (
          <CanvasWorld
            key={activePageId}
            projectId={projectId}
            layout={layout}
            notes={notes}
            versions={versions}
            selectedPath={selectedPath}
            pendingOnly={pendingOnly}
            isPending={isPending}
            focus={focus}
            fitNonce={fitNonce}
            onSelect={setSelectedPath}
            onOpen={(path) => openViewer(path, needsTonyReview(notes[path]))}
            onPlaceRow={(rowId, x, y) => {
              setBoard({
                ...board,
                placements: { ...(board.placements ?? {}), [rowId]: { x, y } },
              });
              void applyEdit({ kind: "place-row", rowId, placement: { x, y } });
            }}
          />
        )}
        {viewerPath !== null ? (
          <div
            className="absolute inset-0 z-30 flex flex-col bg-surface-sunken px-3 pb-3 pt-2"
            data-testid="canvas-viewer"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border-2 border-border-strong bg-surface-raised px-3 py-1.5 text-fg">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {projectImageTag(viewerPath).fileName}
                </p>
                <p className="truncate text-xs text-fg-muted">{reviewLabel(viewerPath)}</p>
              </div>
              <Button type="button" size="sm" variant="secondary" onClick={() => stepViewer(-1)}>
                {t("workbench.canvas.prevImage")}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => stepViewer(1)}>
                {t("workbench.canvas.nextImage")}
              </Button>
              {reviewButton(viewerPath)}
              {rejectButton(viewerPath)}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="canvas-viewer-close"
                onClick={() => setViewerPath(null)}
              >
                {t("workbench.canvas.closeLarge")}
              </Button>
            </div>
            <CanvasViewer
              projectId={projectId}
              path={viewerPath}
              {...(viewerVersion !== undefined ? { version: viewerVersion } : {})}
              annotations={board.annotations[viewerPath] ?? []}
              onAnnotationsCommit={(next, preview) => {
                const path = viewerPath;
                setBoard({ ...board, annotations: { ...board.annotations, [path]: next } });
                commitChain.current = commitChain.current
                  .then(async () => {
                    const saved = await applyEdit({
                      kind: "set-annotations",
                      path,
                      annotations: next,
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
        ) : null}
      </div>
    </div>
  );
}
