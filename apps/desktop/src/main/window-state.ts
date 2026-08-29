import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow, type Rectangle, screen } from "electron";

/**
 * 记住窗口尺寸与位置：存 userData/window-state.json。
 * 文件缺失/损坏/坐标越屏时回退默认值，任何失败路径都不阻断启动。
 */
export interface WindowState {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1200, height: 800, maximized: false };
const FILE_NAME = "window-state.json";
const MIN_SIZE = 200;
const SAVE_DEBOUNCE_MS = 500;

function stateFilePath(): string {
  return join(app.getPath("userData"), FILE_NAME);
}

export function loadWindowState(): WindowState {
  let raw: string;
  try {
    raw = readFileSync(stateFilePath(), "utf8");
  } catch {
    // 首次启动或文件不可读：使用默认值，属正常路径
    return DEFAULT_STATE;
  }
  try {
    const state = normalizeState(JSON.parse(raw));
    if (state === null) {
      console.warn(`[window-state] ${FILE_NAME} 内容非法，回退默认窗口状态`);
      return DEFAULT_STATE;
    }
    return dropOffscreenPosition(state);
  } catch (thrown) {
    console.warn(`[window-state] 解析 ${FILE_NAME} 失败，回退默认窗口状态：${String(thrown)}`);
    return DEFAULT_STATE;
  }
}

function normalizeState(parsed: unknown): WindowState | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const width = record["width"];
  const height = record["height"];
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < MIN_SIZE ||
    height < MIN_SIZE
  ) {
    return null;
  }
  const x = record["x"];
  const y = record["y"];
  const hasPosition =
    typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y);
  return {
    width: Math.round(width),
    height: Math.round(height),
    maximized: record["maximized"] === true,
    ...(hasPosition ? { x: Math.round(x as number), y: Math.round(y as number) } : {}),
  };
}

/** 记录的位置完全落在所有屏幕可视区之外时丢弃坐标（交由系统居中），避免窗口"消失"。 */
function dropOffscreenPosition(state: WindowState): WindowState {
  if (state.x === undefined || state.y === undefined) {
    return state;
  }
  const bounds: Rectangle = { x: state.x, y: state.y, width: state.width, height: state.height };
  const area = screen.getDisplayMatching(bounds).workArea;
  const intersects =
    bounds.x < area.x + area.width &&
    bounds.x + bounds.width > area.x &&
    bounds.y < area.y + area.height &&
    bounds.y + bounds.height > area.y;
  if (intersects) {
    return state;
  }
  return { width: state.width, height: state.height, maximized: state.maximized };
}

export function saveWindowState(window: BrowserWindow): void {
  try {
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: window.isMaximized(),
    };
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), "utf8");
  } catch (thrown) {
    console.error(`[window-state] 保存窗口状态失败：${String(thrown)}`);
  }
}

/** 跟踪窗口几何变化：尺寸/位置变化后防抖保存，关闭前保存最终状态。 */
export function trackWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const scheduleSave = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => saveWindowState(window), SAVE_DEBOUNCE_MS);
  };
  window.on("resize", scheduleSave);
  window.on("move", scheduleSave);
  window.on("close", () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    saveWindowState(window);
  });
}
