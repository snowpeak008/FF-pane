/**
 * 终端 WebGL 渲染的统一装卸（xterm addon-webgl 0.19）。
 *
 * 0.19 的字形图集按字体、主题、缩放在所有终端之间共享一份：只要还有终端开着就不释放，也从不自动清空。
 * 每种「字 + 前景色 + 背景色」占一格，中文、代码高亮、diff 底色、渐变的提示文字会让它一直涨；
 * 页面合并后旧画布要等垃圾回收才放掉。所以：
 * - 图集超过上限，把所有终端的 WebGL 一起卸掉重装，旧图集随最后一个持有者释放；
 * - 合并掉的页、释放后的图集画布当场清成 0×0；卸载时主动释放 WebGL 上下文；
 * - 终端在 WebGL 加载完之前就被销毁（React 开发模式会先挂一次再卸掉），不再装上去。
 * 本文件不碰 DOM，单测直接测；真 addon 的装卸在 terminal-webgl.ts。
 */

/** 图集超过这么大就整体重装。 */
export const WEBGL_ATLAS_BUDGET_BYTES = 64 * 1024 * 1024;
/** 图集加了新页之后隔这么久再量，合并掉连续加页。 */
export const WEBGL_ATLAS_CHECK_MS = 2000;

export interface AtlasCanvas {
  width: number;
  height: number;
}

interface Disposable {
  dispose(): void;
}

type Listen<T> = (listener: (value: T) => void) => Disposable;

/** 装在一个终端上的 WebGL 渲染。 */
export interface WebglRendererLike {
  /** 图集当前的第一页。 */
  readonly textureAtlas?: AtlasCanvas | undefined;
  readonly onChangeTextureAtlas: Listen<AtlasCanvas>;
  readonly onAddTextureAtlasCanvas: Listen<AtlasCanvas>;
  readonly onRemoveTextureAtlasCanvas: Listen<AtlasCanvas>;
  readonly onContextLoss: Listen<void>;
  /** 卸掉渲染（终端退回 DOM 渲染）并释放 WebGL 上下文。 */
  release(): void;
}

export interface WebglPoolDeps<T> {
  /** 给终端装上 WebGL；alive() 为 false 时不要再装。装不上返回 undefined。 */
  readonly install: (term: T, alive: () => boolean) => Promise<WebglRendererLike | undefined>;
  readonly schedule: (delayMs: number, fn: () => void) => () => void;
  readonly budgetBytes?: number;
  readonly onRecycle?: (atlasBytes: number) => void;
}

export interface WebglPoolStats {
  readonly terminals: number;
  readonly webgl: number;
  readonly atlasBytes: number;
  readonly recycles: number;
}

export interface WebglPool<T> {
  /** 给终端装上 WebGL。返回的函数要在销毁终端之前调用。 */
  attach(term: T): () => void;
  stats(): WebglPoolStats;
}

interface Slot<T> {
  readonly term: T;
  renderer?: WebglRendererLike;
  closed: boolean;
  /** 每次装都加一：重装之后，之前还没装完的那次作废。 */
  generation: number;
}

export function createWebglPool<T>(deps: WebglPoolDeps<T>): WebglPool<T> {
  const budget = deps.budgetBytes ?? WEBGL_ATLAS_BUDGET_BYTES;
  const slots = new Set<Slot<T>>();
  const pages = new Set<AtlasCanvas>();
  let cancelCheck: (() => void) | undefined;
  let recycles = 0;

  const atlasBytes = (): number => {
    let total = 0;
    for (const page of pages) {
      total += page.width * page.height * 4;
    }
    return total;
  };

  const wipe = (canvas: AtlasCanvas): void => {
    canvas.width = 0;
    canvas.height = 0;
  };

  const wipeAll = (): void => {
    for (const page of pages) {
      wipe(page);
    }
    pages.clear();
  };

  const release = (slot: Slot<T>): void => {
    const renderer = slot.renderer;
    if (renderer === undefined) {
      return;
    }
    delete slot.renderer;
    try {
      renderer.release();
    } catch {
      // 终端已经没了，渲染跟着没了
    }
  };

  const scheduleCheck = (): void => {
    if (cancelCheck !== undefined) {
      return;
    }
    cancelCheck = deps.schedule(WEBGL_ATLAS_CHECK_MS, () => {
      cancelCheck = undefined;
      const bytes = atlasBytes();
      if (bytes > budget) {
        recycle(bytes);
      }
    });
  };

  const install = (slot: Slot<T>): void => {
    slot.generation += 1;
    const generation = slot.generation;
    const alive = (): boolean => !slot.closed && slot.generation === generation;
    void deps.install(slot.term, alive).then(
      (renderer) => {
        if (renderer === undefined) {
          return;
        }
        if (!alive()) {
          renderer.release();
          return;
        }
        slot.renderer = renderer;
        const track = (canvas: AtlasCanvas): void => {
          pages.add(canvas);
          scheduleCheck();
        };
        if (renderer.textureAtlas !== undefined) {
          track(renderer.textureAtlas);
        }
        renderer.onChangeTextureAtlas(track);
        renderer.onAddTextureAtlasCanvas(track);
        // 合并掉的页已经画进新页、不再用：当场放掉，不等垃圾回收。
        renderer.onRemoveTextureAtlasCanvas((canvas) => {
          pages.delete(canvas);
          wipe(canvas);
        });
        renderer.onContextLoss(() => {
          if (slot.renderer === renderer) {
            release(slot);
          }
        });
      },
      () => undefined,
    );
  };

  const recycle = (bytes: number): void => {
    recycles += 1;
    deps.onRecycle?.(bytes);
    for (const slot of slots) {
      release(slot);
    }
    // 所有终端都卸了，共享图集已经释放：剩下的画布当场放掉。
    wipeAll();
    for (const slot of slots) {
      install(slot);
    }
  };

  return {
    attach(term) {
      const slot: Slot<T> = { term, closed: false, generation: 0 };
      slots.add(slot);
      install(slot);
      return () => {
        if (slot.closed) {
          return;
        }
        slot.closed = true;
        slots.delete(slot);
        release(slot);
        if (slots.size === 0) {
          wipeAll();
          cancelCheck?.();
          cancelCheck = undefined;
        }
      };
    },
    stats() {
      let webgl = 0;
      for (const slot of slots) {
        if (slot.renderer !== undefined) {
          webgl += 1;
        }
      }
      return { terminals: slots.size, webgl, atlasBytes: atlasBytes(), recycles };
    },
  };
}
