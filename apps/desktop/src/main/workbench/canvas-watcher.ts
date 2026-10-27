/**
 * 只监听 `<项目>/.ffpane/canvas/` 新出现的图片，自动写入 board.json。
 */

import { type FSWatcher, watch } from "node:fs";
import { join, resolve } from "node:path";
import { CANVAS_SUBDIR, ingestCanvasDirectoryFile } from "./canvas-files";

const watchers = new Map<string, FSWatcher>();
/** 目录监听真的收进一张新图时通知（按项目，第一次登记的为准）。 */
const onAddedByRoot = new Map<string, () => void>();

/** Windows 写一个文件会连发好几次事件，每次都整份读写 board.json；同一文件 300ms 内只收一次（T11.0d）。 */
const INGEST_DEBOUNCE_MS = 300;
const pendingIngest = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleIngest(projectRoot: string, fileName: string): void {
  const key = `${watcherKey(projectRoot)}|${fileName}`;
  const before = pendingIngest.get(key);
  if (before !== undefined) {
    clearTimeout(before);
  }
  const timer = setTimeout(() => {
    pendingIngest.delete(key);
    void ingestCanvasDirectoryFile(projectRoot, fileName)
      .then((added) => {
        if (added) {
          onAddedByRoot.get(watcherKey(projectRoot))?.();
        }
      })
      .catch(() => {
        // 忽略单次写入竞争
      });
  }, INGEST_DEBOUNCE_MS);
  timer.unref?.();
  pendingIngest.set(key, timer);
}

function watcherKey(projectRoot: string): string {
  return resolve(projectRoot);
}

export function ensureCanvasWatcher(projectRoot: string, onAdded?: () => void): void {
  const key = watcherKey(projectRoot);
  if (onAdded !== undefined && !onAddedByRoot.has(key)) {
    onAddedByRoot.set(key, onAdded);
  }
  if (watchers.has(key)) {
    return;
  }
  const dir = join(resolve(projectRoot), ".ffpane", CANVAS_SUBDIR);
  try {
    const watcher = watch(dir, { persistent: false }, (_event, fileName) => {
      if (typeof fileName !== "string" || fileName.trim() === "") {
        return;
      }
      scheduleIngest(projectRoot, fileName);
    });
    watcher.on("error", () => {
      stopCanvasWatcher(projectRoot);
    });
    watchers.set(key, watcher);
  } catch {
    // 目录可能尚未创建，等下次 get-canvas 再试
  }
}

export function stopCanvasWatcher(projectRoot: string): void {
  const key = watcherKey(projectRoot);
  const watcher = watchers.get(key);
  if (watcher !== undefined) {
    watcher.close();
    watchers.delete(key);
  }
  onAddedByRoot.delete(key);
}

export function stopAllCanvasWatchers(): void {
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  watchers.clear();
  onAddedByRoot.clear();
}
