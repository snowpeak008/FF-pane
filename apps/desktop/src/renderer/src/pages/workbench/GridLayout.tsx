/**
 * 格子布局（T11.2b；T11.2d 起按个数自动排）：每页最多 6 个窗口。
 * 横向 1 整屏、2 左右、3 三列、4 2×2、5 上 3 下 2、6 上 3 下 3；竖向转 90°。
 * 按工作台区域的宽高自动换方向（0.9–1.1 之间不换，免得来回跳）。
 *
 * 所有窗口画在同一层、按窗口 id 做 key，位置用绝对定位给出：加窗口、关窗口、对调、最大化、
 * 换方向时窗口只挪位置，终端不重建（不再重读回放、不重建显卡绘制）。
 * 分隔线自己画：拖的时候只改界面，松手才存一次；只改相邻的两条或两格；双击恢复均分。
 * 放哪、比例怎么算都在 shared/workbench/grid.ts。按住标题栏拖窗口（T11.2c）：每个窗口都是落点。
 */

import type { ProjectId, WorkbenchGridSizes, WorkbenchWindow } from "@ff-pane/shared";
import {
  type CSSProperties,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type GridDivider,
  type GridOrientation,
  type GridSizesForOrientation,
  type GridSlots,
  gridCellRects,
  gridDividers,
  gridSizesFor,
  orientationFor,
  resizePair,
  windowIdsInSlots,
} from "../../../../shared/workbench/grid";
import { cn } from "../../lib/cn";
import { WindowPane } from "./WindowPane";
import type { WindowDragState } from "./window-drag";

/** 分隔线粗细（px），居中压在两格的交界上。 */
const DIVIDER_PX = 4;

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
  readonly onAddWindow: (windowId: string) => void;
  readonly onToggleMaximize: (windowId: string) => void;
  readonly onRename: (windowId: string, title: string) => void;
  readonly onTerminalIdChange: (windowId: string, terminalId: string | undefined) => void;
  readonly onCwdFallback: (windowId: string) => void;
  readonly onLineSizes: (
    orientation: GridOrientation,
    count: number,
    lines: readonly number[],
  ) => void;
  readonly onCellSizes: (
    orientation: GridOrientation,
    count: number,
    line: number,
    cells: readonly number[],
  ) => void;
  readonly onResetSizes: (orientation: GridOrientation) => void;
  readonly drag: WindowDragState | null;
  readonly onDragStart: (windowId: string, event: ReactPointerEvent<HTMLElement>) => void;
}

function percent(value: number): string {
  return `${value * 100}%`;
}

function dividerStyle(divider: GridDivider): CSSProperties {
  const offset = `calc(${percent(divider.at)} - ${DIVIDER_PX / 2}px)`;
  const span = percent(divider.to - divider.from);
  return divider.vertical
    ? { left: offset, top: percent(divider.from), width: DIVIDER_PX, height: span }
    : { top: offset, left: percent(divider.from), height: DIVIDER_PX, width: span };
}

/** 拖分隔线：按指针挪了多少换算成比例，只改这一对。线里的格子也是占满整个区域的比例。 */
function dragSizes(
  sizes: GridSizesForOrientation,
  divider: GridDivider,
  deltaFraction: number,
): GridSizesForOrientation {
  if (divider.kind === "line") {
    return { ...sizes, lines: resizePair(sizes.lines, divider.index, deltaFraction) };
  }
  return {
    ...sizes,
    cells: sizes.cells.map((values, line) =>
      line === divider.line ? resizePair(values, divider.index, deltaFraction) : values,
    ),
  };
}

export function GridLayout(props: GridLayoutProps): ReactElement | null {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [orientation, setOrientation] = useState<GridOrientation>("landscape");
  /** 正在拖分隔线时的比例，松手前只改界面。 */
  const [live, setLive] = useState<GridSizesForOrientation | null>(null);

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

  const ids = windowIdsInSlots(props.slots);
  const count = ids.length;
  const sizes = live ?? gridSizesFor(props.sizes, orientation, count);
  const rects = gridCellRects(count, orientation, sizes);
  const dividers = gridDividers(count, orientation, sizes);
  const maximizedId =
    props.maximizedWindowId !== null && ids.includes(props.maximizedWindowId)
      ? props.maximizedWindowId
      : null;

  const startDividerDrag = (
    divider: GridDivider,
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const el = containerRef.current;
    if (event.button !== 0 || el === null) {
      return;
    }
    event.preventDefault();
    const handle = event.currentTarget;
    const { pointerId } = event;
    const box = el.getBoundingClientRect();
    const length = divider.vertical ? box.width : box.height;
    const start = divider.vertical ? event.clientX : event.clientY;
    const base = gridSizesFor(props.sizes, orientation, count);
    let latest = base;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // 指针已经松开
    }
    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId || length <= 0) {
        return;
      }
      const now = divider.vertical ? move.clientX : move.clientY;
      latest = dragSizes(base, divider, (now - start) / length);
      setLive(latest);
    };
    const onUp = (up: PointerEvent): void => {
      if (up.pointerId !== pointerId) {
        return;
      }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setLive(null);
      if (latest === base) {
        return;
      }
      if (divider.kind === "line") {
        props.onLineSizes(orientation, count, latest.lines);
      } else {
        props.onCellSizes(orientation, count, divider.line, latest.cells[divider.line] ?? []);
      }
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 min-w-0 flex-1"
      data-orientation={orientation}
      data-count={count}
    >
      {ids.map((windowId, slot) => {
        const window = props.windows[windowId];
        const rect = rects[slot];
        if (window === undefined || rect === undefined) {
          return null;
        }
        const maximized = maximizedId === windowId;
        const hidden = maximizedId !== null && !maximized;
        const target = props.drag?.target;
        const dropHere =
          target?.kind === "slot" &&
          target.tabId === props.tabId &&
          target.slot === slot &&
          windowId !== props.drag?.windowId;
        const box = maximized ? { left: 0, top: 0, width: 1, height: 1 } : rect;
        return (
          <div
            key={windowId}
            className={cn("absolute flex min-h-0 min-w-0 flex-col p-0.5", maximized && "z-10")}
            style={{
              left: percent(box.left),
              top: percent(box.top),
              width: percent(box.width),
              height: percent(box.height),
              // 最大化时其余窗口只是藏起来，尺寸不变，终端不跟着重排。
              ...(hidden ? { visibility: "hidden" as const } : {}),
            }}
            data-testid="workbench-grid-cell"
            data-drop="slot"
            data-tab-id={props.tabId}
            data-slot={slot}
            data-drop-active={dropHere ? "true" : undefined}
          >
            <WindowPane
              window={window}
              projectRoot={props.projectRoot}
              focused={maximized || props.focusedWindowId === window.id}
              maximized={maximized}
              onFocus={() => props.onFocus(window.id)}
              onClose={() => props.onClose(window.id)}
              onAddWindow={() => props.onAddWindow(window.id)}
              onToggleMaximize={() => props.onToggleMaximize(window.id)}
              onRename={(title) => props.onRename(window.id, title)}
              onTerminalIdChange={(id) => props.onTerminalIdChange(window.id, id)}
              onCwdFallback={() => props.onCwdFallback(window.id)}
              onDragStart={(event) => props.onDragStart(window.id, event)}
              dragging={props.drag?.windowId === window.id}
            />
            {dropHere ? (
              <div className="pointer-events-none absolute inset-0.5 z-20 rounded-md border-2 border-primary bg-primary-surface/40" />
            ) : null}
          </div>
        );
      })}
      {maximizedId === null
        ? dividers.map((divider) => (
            <div
              key={`${divider.kind}-${divider.line}-${divider.index}`}
              aria-hidden
              data-testid="workbench-grid-divider"
              data-vertical={divider.vertical ? "true" : undefined}
              className={cn(
                "absolute z-10 bg-border transition-colors hover:bg-primary",
                divider.vertical ? "cursor-col-resize" : "cursor-row-resize",
              )}
              style={dividerStyle(divider)}
              onPointerDown={(event) => startDividerDrag(divider, event)}
              onDoubleClick={() => props.onResetSizes(orientation)}
            />
          ))
        : null}
    </div>
  );
}
