/**
 * 拖窗口换位置（T11.2c）：按住窗口标题栏拖。不加库，用指针事件。
 * 动了 5px 才算拖；开始拖就把指针锁在标题栏上（setPointerCapture），终端收不到鼠标事件。
 * 落点按指针下面带 data-drop 的元素算：格子、标签、标签栏的「＋」。Esc 取消。
 * 怎么对调、移动在 shared/workbench/grid.ts 的 moveWindowInLayout。
 */

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { dropTargetOf, type WindowDropTarget } from "../../../../shared/workbench/grid";

const DRAG_THRESHOLD_PX = 5;

export interface WindowDragState {
  readonly windowId: string;
  readonly target: WindowDropTarget | null;
}

function dropTargetAt(x: number, y: number): WindowDropTarget | null {
  const host = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
  return host === null || host === undefined ? null : dropTargetOf(host.dataset);
}

function sameTarget(a: WindowDropTarget | null, b: WindowDropTarget | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useWindowDrag(onDrop: (windowId: string, target: WindowDropTarget) => void): {
  readonly drag: WindowDragState | null;
  readonly start: (windowId: string, event: ReactPointerEvent<HTMLElement>) => void;
} {
  const [drag, setDrag] = useState<WindowDragState | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const start = useCallback((windowId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }
    cleanupRef.current?.();
    const handle = event.currentTarget;
    const { pointerId, clientX: startX, clientY: startY } = event;
    let active = false;
    let target: WindowDropTarget | null = null;

    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) {
        return;
      }
      if (!active) {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        active = true;
        try {
          handle.setPointerCapture(pointerId);
        } catch {
          // 指针已经松开
        }
        handle.style.cursor = "grabbing";
        setDrag({ windowId, target: null });
      }
      const next = dropTargetAt(move.clientX, move.clientY);
      if (!sameTarget(next, target)) {
        target = next;
        setDrag({ windowId, target });
      }
    };
    const finish = (drop: boolean): void => {
      const dropped = drop && active ? target : null;
      cleanup();
      if (dropped !== null) {
        onDropRef.current(windowId, dropped);
      }
    };
    const onUp = (up: PointerEvent): void => {
      if (up.pointerId === pointerId) {
        finish(true);
      }
    };
    const onCancel = (cancel: PointerEvent): void => {
      if (cancel.pointerId === pointerId) {
        finish(false);
      }
    };
    const onKey = (key: KeyboardEvent): void => {
      if (key.key === "Escape" && active) {
        key.preventDefault();
        key.stopPropagation();
        finish(false);
      }
    };
    const cleanup = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      if (active) {
        handle.style.cursor = "";
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
        setDrag(null);
      }
      cleanupRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    cleanupRef.current = cleanup;
  }, []);

  return { drag, start };
}
