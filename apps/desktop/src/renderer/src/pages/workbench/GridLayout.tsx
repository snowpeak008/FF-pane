/**
 * 固定格子布局（T11.2b，取代 SplitLayout 的分屏树）：每页 6 格。
 * 横向 3 列 × 2 行、竖向 2 列 × 3 行，按工作台区域的宽高自动换（0.9–1.1 之间不换，免得来回跳）。
 * 每一行是独立的一组：拖行里的竖线只改左右两格；拖行之间的横线只改这两行。双击分隔线恢复均分。
 * 空格子显示「＋ 新建窗口」。放哪、比例怎么算都在 shared/workbench/grid.ts。
 * 按住标题栏拖窗口（T11.2c）：每格都是落点，拖动时目标格高亮。
 */

import type { ProjectId, WorkbenchGridSizes, WorkbenchWindow } from "@ff-pane/shared";
import { Plus } from "lucide-react";
import {
  Fragment,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  GRID_SHAPE,
  type GridOrientation,
  type GridSlots,
  gridSizesFor,
  orientationFor,
  slotAt,
} from "../../../../shared/workbench/grid";
import { cn } from "../../lib/cn";
import { WindowPane } from "./WindowPane";
import type { WindowDragState } from "./window-drag";

/** 每格最小占比（%）。 */
const MIN_CELL_PERCENT = 10;
/** 行的固定编号（最多 3 行），做 React key 和面板 id。 */
const ROW_IDS = ["row-0", "row-1", "row-2"] as const;

export interface GridLayoutProps {
  readonly tabId: string;
  readonly slots: GridSlots;
  readonly sizes: WorkbenchGridSizes | undefined;
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly windows: Readonly<Record<string, WorkbenchWindow>>;
  readonly focusedWindowId: string | null;
  readonly maximizedWindowId: string | null;
  readonly onFocus: (windowId: string) => void;
  readonly onClose: (windowId: string) => void;
  readonly onSplitRight: (windowId: string) => void;
  readonly onSplitDown: (windowId: string) => void;
  readonly onToggleMaximize: (windowId: string) => void;
  readonly onRename: (windowId: string, title: string) => void;
  readonly onTerminalIdChange: (windowId: string, terminalId: string | undefined) => void;
  readonly onCwdFallback: (windowId: string) => void;
  readonly onCreateInSlot: (slot: number) => void;
  readonly onOrientationChange: (orientation: GridOrientation) => void;
  readonly onRowSizes: (orientation: GridOrientation, rows: readonly number[]) => void;
  readonly onColSizes: (orientation: GridOrientation, row: number, cols: readonly number[]) => void;
  readonly onResetSizes: (orientation: GridOrientation) => void;
  readonly drag: WindowDragState | null;
  readonly onDragStart: (windowId: string, event: ReactPointerEvent<HTMLElement>) => void;
}

function percents(fractions: readonly number[]): number[] {
  return fractions.map((value) => value * 100);
}

function changed(next: readonly number[], current: readonly number[]): boolean {
  return next.some((value, index) => Math.abs(value - (current[index] ?? 0)) >= 0.5);
}

export function GridLayout(props: GridLayoutProps): ReactElement | null {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [orientation, setOrientation] = useState<GridOrientation>("landscape");
  const onOrientationChange = props.onOrientationChange;

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) {
      return;
    }
    const measure = (): void => {
      setOrientation((current) => orientationFor(el.clientWidth, el.clientHeight, current));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    onOrientationChange(orientation);
  }, [onOrientationChange, orientation]);

  const pane = (window: WorkbenchWindow, maximized: boolean): ReactElement => (
    <WindowPane
      window={window}
      projectRoot={props.projectRoot}
      focused={maximized || props.focusedWindowId === window.id}
      maximized={maximized}
      onFocus={() => props.onFocus(window.id)}
      onClose={() => props.onClose(window.id)}
      onSplitRight={() => props.onSplitRight(window.id)}
      onSplitDown={() => props.onSplitDown(window.id)}
      onToggleMaximize={() => props.onToggleMaximize(window.id)}
      onRename={(title) => props.onRename(window.id, title)}
      onTerminalIdChange={(id) => props.onTerminalIdChange(window.id, id)}
      onCwdFallback={() => props.onCwdFallback(window.id)}
      onDragStart={(event) => props.onDragStart(window.id, event)}
      dragging={props.drag?.windowId === window.id}
    />
  );

  const maximized =
    props.maximizedWindowId !== null && props.slots.includes(props.maximizedWindowId)
      ? props.windows[props.maximizedWindowId]
      : undefined;

  const { rows, cols } = GRID_SHAPE[orientation];
  const sizes = gridSizesFor(props.sizes, orientation);
  const rowPercents = percents(sizes.rows);

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col" data-orientation={orientation}>
      {maximized !== undefined ? (
        <div className="flex min-h-0 flex-1 flex-col">{pane(maximized, true)}</div>
      ) : (
        <PanelGroup
          key={`${props.tabId}-${orientation}`}
          id={`grid-${props.tabId}-${orientation}`}
          direction="vertical"
          className="min-h-0 min-w-0 flex-1"
          onLayout={(layout) => {
            if (changed(layout, rowPercents)) {
              props.onRowSizes(
                orientation,
                layout.map((value) => value / 100),
              );
            }
          }}
        >
          {ROW_IDS.slice(0, rows).map((rowId, row) => {
            const colPercents = percents(sizes.cols[row] ?? []);
            return (
              <Fragment key={rowId}>
                {row > 0 ? (
                  <PanelResizeHandle
                    className="h-1 bg-border transition-colors hover:bg-primary"
                    onDoubleClick={() => props.onResetSizes(orientation)}
                  />
                ) : null}
                <Panel
                  id={rowId}
                  order={row}
                  defaultSize={rowPercents[row]}
                  minSize={MIN_CELL_PERCENT}
                  className="min-h-0 min-w-0"
                >
                  <PanelGroup
                    id={`grid-${props.tabId}-${orientation}-row-${row}`}
                    direction="horizontal"
                    className="min-h-0 min-w-0"
                    onLayout={(layout) => {
                      if (changed(layout, colPercents)) {
                        props.onColSizes(
                          orientation,
                          row,
                          layout.map((value) => value / 100),
                        );
                      }
                    }}
                  >
                    {Array.from({ length: cols }, (_, col) => {
                      const slot = slotAt(row, col, orientation);
                      const windowId = props.slots[slot] ?? null;
                      const window = windowId !== null ? props.windows[windowId] : undefined;
                      const target = props.drag?.target;
                      const dropHere =
                        target?.kind === "slot" &&
                        target.tabId === props.tabId &&
                        target.slot === slot &&
                        windowId !== props.drag?.windowId;
                      return (
                        <Fragment key={`cell-${slot}`}>
                          {col > 0 ? (
                            <PanelResizeHandle
                              className="w-1 bg-border transition-colors hover:bg-primary"
                              onDoubleClick={() => props.onResetSizes(orientation)}
                            />
                          ) : null}
                          <Panel
                            id={`cell-${slot}`}
                            order={col}
                            defaultSize={colPercents[col]}
                            minSize={MIN_CELL_PERCENT}
                            className="min-h-0 min-w-0"
                          >
                            <div
                              className="relative flex h-full min-h-0 flex-col p-0.5"
                              data-testid="workbench-grid-cell"
                              data-drop="slot"
                              data-tab-id={props.tabId}
                              data-slot={slot}
                              data-drop-active={dropHere ? "true" : undefined}
                            >
                              {window !== undefined ? (
                                pane(window, false)
                              ) : (
                                <button
                                  type="button"
                                  data-testid="workbench-grid-empty"
                                  data-slot={slot}
                                  className={cn(
                                    "flex h-full w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-sm text-fg-muted",
                                    "hover:border-primary hover:bg-surface-hover hover:text-fg",
                                  )}
                                  onClick={() => props.onCreateInSlot(slot)}
                                >
                                  <Plus aria-hidden size={18} />
                                  {t("workbench.grid.newWindowHere")}
                                </button>
                              )}
                              {dropHere ? (
                                <div className="pointer-events-none absolute inset-0.5 z-20 rounded-md border-2 border-primary bg-primary-surface/40" />
                              ) : null}
                            </div>
                          </Panel>
                        </Fragment>
                      );
                    })}
                  </PanelGroup>
                </Panel>
              </Fragment>
            );
          })}
        </PanelGroup>
      )}
    </div>
  );
}
