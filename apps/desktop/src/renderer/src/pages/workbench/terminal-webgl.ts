/**
 * 真 addon-webgl 的装卸，接到 webgl-pool 上。所有终端共用这一个池。
 */

import type { Terminal } from "@xterm/xterm";
import { createWebglPool, type WebglRendererLike } from "./webgl-pool";

let addonModule: Promise<typeof import("@xterm/addon-webgl")> | undefined;

async function installWebgl(
  term: Terminal,
  alive: () => boolean,
): Promise<WebglRendererLike | undefined> {
  addonModule ??= import("@xterm/addon-webgl");
  let WebglAddon: typeof import("@xterm/addon-webgl")["WebglAddon"];
  try {
    ({ WebglAddon } = await addonModule);
  } catch {
    addonModule = undefined;
    return undefined;
  }
  const host = term.element;
  if (!alive() || host === undefined) {
    return undefined;
  }
  const before = new Set(host.querySelectorAll("canvas"));
  const addon = new WebglAddon();
  try {
    term.loadAddon(addon);
  } catch {
    // WebGL unavailable: keep the DOM renderer
    try {
      addon.dispose();
    } catch {
      // nothing left to release
    }
    return undefined;
  }
  // 渲染自己建的画布：卸载后要主动释放上下文，否则要等垃圾回收，攒多了浏览器会挤掉还在用的终端。
  const created = [...host.querySelectorAll("canvas")].filter((canvas) => !before.has(canvas));
  return {
    get textureAtlas() {
      return addon.textureAtlas;
    },
    onChangeTextureAtlas: addon.onChangeTextureAtlas,
    onAddTextureAtlasCanvas: addon.onAddTextureAtlasCanvas,
    onRemoveTextureAtlasCanvas: addon.onRemoveTextureAtlasCanvas,
    onContextLoss: addon.onContextLoss,
    release() {
      addon.dispose();
      for (const canvas of created) {
        // 2D 画布上取 webgl2 返回 null，只有渲染那块会拿到上下文。
        canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
      }
    },
  };
}

/** 和主进程的内存记录同一频率。 */
const REPORT_INTERVAL_MS = 5 * 60_000;

/**
 * 每 5 分钟往控制台写一行界面内存：主进程把 [renderer-mem] 开头的行收进日志，
 * 界面进程再涨时分得清是 JS 堆、图集还是别的。
 */
export function startRendererMemoryReport(): void {
  setInterval(() => {
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const stats = terminalWebgl.stats();
    console.info(
      `[renderer-mem] jsHeap=${heap === undefined ? "?" : Math.round(heap.usedJSHeapSize / 1048576)}MB terminals=${stats.terminals} webgl=${stats.webgl} atlas=${Math.round(stats.atlasBytes / 1048576)}MB atlasRecycles=${stats.recycles} dom=${document.getElementsByTagName("*").length}`,
    );
  }, REPORT_INTERVAL_MS);
}

export const terminalWebgl = createWebglPool<Terminal>({
  install: installWebgl,
  schedule: (delayMs, fn) => {
    const timer = setTimeout(fn, delayMs);
    return () => clearTimeout(timer);
  },
  onRecycle: (atlasBytes) => {
    console.info(`[renderer-mem] webgl atlas recycled at ${Math.round(atlasBytes / 1048576)}MB`);
  },
});
