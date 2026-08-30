/**
 * window.ffpane 取值入口 —— 渲染层访问 IPC 的唯一出发点（W3.1c）。
 *
 * 为什么不在各处直接写 window.ffpane：
 * 1. 纯逻辑单测（vitest node 环境，无 jsdom）可以往 globalThis 上注入假 window.ffpane；
 * 2. preload 未加载时给出可读的开发者异常，而不是 "cannot read properties of undefined"。
 *
 * 本文件刻意不依赖 DOM 类型：tests/ 归属 tsconfig.node.json（lib 无 DOM），
 * 而 tests 会把本模块拉进同一程序，任何 DOM 类型引用都会让 typecheck 失败。
 */
import type { FfPaneIpcApi } from "../../../shared-ipc/client";

/** globalThis 上与本模块相关的最小形状（避免引用 DOM 的 Window 类型）。 */
interface FfPaneScope {
  readonly window?: { readonly ffpane?: FfPaneIpcApi };
}

function readScope(): FfPaneScope {
  return globalThis as unknown as FfPaneScope;
}

/** preload 是否已经把受控 IPC API 暴露到当前全局。 */
export function hasIpcApi(): boolean {
  return readScope().window?.ffpane !== undefined;
}

/** 取受控 IPC API；未注入时抛出开发者异常（英文，check-i18n 约定）。 */
export function getIpcApi(): FfPaneIpcApi {
  const api = readScope().window?.ffpane;
  if (api === undefined) {
    throw new Error("ipc unavailable: window.ffpane is not exposed (preload did not load)");
  }
  return api;
}
