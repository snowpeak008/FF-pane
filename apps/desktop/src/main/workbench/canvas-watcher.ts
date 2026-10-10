/**
 * 只监听 `<项目>/.ffpane/canvas/` 新出现的图片，自动写入 board.json。
 */

import { type FSWatcher, watch } from "node:fs";
import { join, resolve } from "node:path";
import { CANVAS_SUBDIR, ingestCanvasDirectoryFile } from "./canvas-files";

const watchers = new Map<string, FSWatcher>();

function watcherKey(projectRoot: string): string {
  return resolve(projectRoot);
}

export function ensureCanvasWatcher(projectRoot: string): void {
  const key = watcherKey(projectRoot);
  if (watchers.has(key)) {
    return;
  }
  const dir = join(resolve(projectRoot), ".ffpane", CANVAS_SUBDIR);
  try {
    const watcher = watch(dir, { persistent: false }, (_event, fileName) => {
      if (typeof fileName !== "string" || fileName.trim() === "") {
        return;
      }
      void ingestCanvasDirectoryFile(projectRoot, fileName).catch(() => {
        // 忽略单次写入竞争
      });
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
}

export function stopAllCanvasWatchers(): void {
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  watchers.clear();
}
