/**
 * 终端 WebGL 装卸：图集超限整体重装、合并掉的页当场放掉、销毁前没装完的不再装。
 */

import { describe, expect, it } from "vitest";
import {
  type AtlasCanvas,
  createWebglPool,
  WEBGL_ATLAS_CHECK_MS,
  type WebglRendererLike,
} from "../src/renderer/src/pages/workbench/webgl-pool";

function emitter<T>() {
  const listeners: ((value: T) => void)[] = [];
  return {
    listen: (listener: (value: T) => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
    fire: (value: T) => {
      for (const listener of listeners) {
        listener(value);
      }
    },
  };
}

interface FakeRenderer extends WebglRendererLike {
  readonly term: string;
  released: boolean;
  addPage(size: number): AtlasCanvas;
  removePage(canvas: AtlasCanvas): void;
  loseContext(): void;
}

function setup(budgetBytes = 1000) {
  const renderers: FakeRenderer[] = [];
  const pending: { resolve: () => void }[] = [];
  const timers: { delay: number; fn: () => void; cancelled: boolean }[] = [];
  let deferInstall = false;
  const recycled: number[] = [];

  const makeRenderer = (term: string): FakeRenderer => {
    const change = emitter<AtlasCanvas>();
    const add = emitter<AtlasCanvas>();
    const remove = emitter<AtlasCanvas>();
    const lost = emitter<void>();
    const first: AtlasCanvas = { width: 4, height: 4 };
    const renderer: FakeRenderer = {
      term,
      released: false,
      textureAtlas: first,
      onChangeTextureAtlas: change.listen,
      onAddTextureAtlasCanvas: add.listen,
      onRemoveTextureAtlasCanvas: remove.listen,
      onContextLoss: lost.listen,
      release() {
        renderer.released = true;
      },
      addPage(size) {
        const canvas = { width: size, height: size };
        add.fire(canvas);
        return canvas;
      },
      removePage(canvas) {
        remove.fire(canvas);
      },
      loseContext() {
        lost.fire();
      },
    };
    return renderer;
  };

  const pool = createWebglPool<string>({
    budgetBytes,
    install: (term, alive) =>
      new Promise((resolve) => {
        const finish = (): void => {
          if (!alive()) {
            resolve(undefined);
            return;
          }
          const renderer = makeRenderer(term);
          renderers.push(renderer);
          resolve(renderer);
        };
        if (deferInstall) {
          pending.push({ resolve: finish });
        } else {
          finish();
        }
      }),
    schedule: (delay, fn) => {
      const timer = { delay, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    onRecycle: (bytes) => recycled.push(bytes),
  });

  const runTimers = (): void => {
    for (const timer of timers.splice(0)) {
      if (!timer.cancelled) {
        timer.fn();
      }
    }
  };

  return {
    pool,
    renderers,
    pending,
    timers,
    recycled,
    runTimers,
    defer: () => {
      deferInstall = true;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createWebglPool", () => {
  it("终端在 WebGL 装完之前就销毁：不再装上去", async () => {
    const t = setup();
    t.defer();
    const detach = t.pool.attach("a");
    detach();
    t.pending[0]?.resolve();
    await flush();
    expect(t.renderers).toEqual([]);
    expect(t.pool.stats()).toMatchObject({ terminals: 0, webgl: 0 });
  });

  it("图集没超上限不重装", async () => {
    const t = setup(1000);
    t.pool.attach("a");
    await flush();
    t.renderers[0]?.addPage(8);
    expect(t.timers[0]?.delay).toBe(WEBGL_ATLAS_CHECK_MS);
    t.runTimers();
    expect(t.recycled).toEqual([]);
    expect(t.renderers.every((r) => !r.released)).toBe(true);
  });

  it("图集超过上限：所有终端一起卸掉重装，旧画布清成 0×0", async () => {
    const t = setup(1000);
    t.pool.attach("a");
    t.pool.attach("b");
    await flush();
    const big = t.renderers[0]?.addPage(20);
    const first = t.renderers[0]?.textureAtlas;
    t.runTimers();
    expect(t.recycled).toHaveLength(1);
    expect(t.renderers.slice(0, 2).every((r) => r.released)).toBe(true);
    expect(big).toEqual({ width: 0, height: 0 });
    expect(first).toEqual({ width: 0, height: 0 });
    await flush();
    expect(t.renderers.map((r) => r.term)).toEqual(["a", "b", "a", "b"]);
    expect(t.pool.stats()).toMatchObject({ terminals: 2, webgl: 2, recycles: 1 });
  });

  it("加页连着来只量一次", async () => {
    const t = setup(1_000_000);
    t.pool.attach("a");
    await flush();
    t.renderers[0]?.addPage(8);
    t.renderers[0]?.addPage(8);
    t.renderers[0]?.addPage(8);
    expect(t.timers).toHaveLength(1);
  });

  it("合并掉的页当场清成 0×0，不再算进图集", async () => {
    const t = setup();
    t.pool.attach("a");
    await flush();
    const page = t.renderers[0]?.addPage(10);
    expect(t.pool.stats().atlasBytes).toBe((16 + 100) * 4);
    if (page !== undefined) {
      t.renderers[0]?.removePage(page);
    }
    expect(page).toEqual({ width: 0, height: 0 });
    expect(t.pool.stats().atlasBytes).toBe(16 * 4);
  });

  it("最后一个终端关掉：图集画布全部放掉", async () => {
    const t = setup();
    const detachA = t.pool.attach("a");
    const detachB = t.pool.attach("b");
    await flush();
    const page = t.renderers[0]?.addPage(10);
    detachA();
    expect(page).toEqual({ width: 10, height: 10 });
    detachB();
    expect(page).toEqual({ width: 0, height: 0 });
    expect(t.renderers.every((r) => r.released)).toBe(true);
    expect(t.timers.every((timer) => timer.cancelled)).toBe(true);
  });

  it("WebGL 上下文丢了只卸这一个，终端退回 DOM 渲染", async () => {
    const t = setup();
    t.pool.attach("a");
    t.pool.attach("b");
    await flush();
    t.renderers[0]?.loseContext();
    expect(t.renderers[0]?.released).toBe(true);
    expect(t.renderers[1]?.released).toBe(false);
    expect(t.pool.stats()).toMatchObject({ terminals: 2, webgl: 1 });
  });

  it("重装途中又关掉：之前那次装完也不留", async () => {
    const t = setup(100);
    const detach = t.pool.attach("a");
    await flush();
    t.renderers[0]?.addPage(10);
    t.defer();
    t.runTimers();
    detach();
    t.pending[0]?.resolve();
    await flush();
    expect(t.renderers).toHaveLength(1);
    expect(t.pool.stats()).toMatchObject({ terminals: 0, webgl: 0 });
  });
});
