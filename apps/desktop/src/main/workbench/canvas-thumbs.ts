/**
 * 画板缩略图和 `ffpane-canvas://` 协议（T11.0d）。
 *
 * - 缩略图用 Electron 的 nativeImage.createThumbnailFromPath（系统缩略图，不在主线程上解码），
 *   长边 256（画布上）和 1024（放大时，T11.0c），存 PNG（游戏素材常带透明，JPEG 会把透明处变黑）；
 * - 缓存放在 FF-pane 数据根的 `cache/canvas-thumbs/` 下，不写进用户项目；
 *   文件名带原图路径、大小、修改时间，原图变了自动重做；
 * - 一次最多做 4 张，其余排队；
 * - 原图和缩略图都直接回文件，不转 base64。
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeImage, net } from "electron";
import {
  type CanvasImageSize,
  canvasImageEdge,
  parseCanvasImageUrl,
} from "../../shared/canvas-image-url";
import { resolveCanvasImage, writeAtomic } from "./canvas-files";

const THUMB_CONCURRENCY = 4;

let active = 0;
const waiting: Array<() => void> = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (active >= THUMB_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  }
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/** 同一张缩略图同时被要了好几次，只做一次。 */
const inflight = new Map<string, Promise<string>>();

export function canvasThumbCacheName(
  projectRoot: string,
  relative: string,
  size: number,
  mtimeMs: number,
): string {
  const key = `${projectRoot.toLowerCase()}|${relative}|${size}|${Math.floor(mtimeMs)}`;
  return `${createHash("sha1").update(key).digest("hex")}.png`;
}

async function makeThumb(source: string, target: string, edge: number): Promise<string> {
  let image = await nativeImage
    .createThumbnailFromPath(source, { width: edge, height: edge })
    .catch(() => nativeImage.createFromPath(source));
  if (image.isEmpty()) {
    return source;
  }
  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  if (longest > edge) {
    image =
      size.width >= size.height
        ? image.resize({ width: edge, quality: "good" })
        : image.resize({ height: edge, quality: "good" });
  }
  await writeAtomic(target, image.toPNG());
  return target;
}

/** 要回给界面的文件：原图，或缓存里的缩略图（没有就先做）。 */
export async function canvasImageFile(
  projectRoot: string,
  relativePath: string,
  size: CanvasImageSize,
  cacheDir: string,
): Promise<
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string }
> {
  const resolved = await resolveCanvasImage(projectRoot, relativePath);
  if (!resolved.ok) {
    return resolved;
  }
  if (size === "full") {
    return { ok: true, path: resolved.absolute };
  }
  const info = await stat(resolved.absolute);
  const edge = canvasImageEdge(size);
  const target = join(
    cacheDir,
    canvasThumbCacheName(projectRoot, resolved.relative, edge, info.mtimeMs),
  );
  const cached = await stat(target).then(
    (found) => found.isFile(),
    () => false,
  );
  if (cached) {
    return { ok: true, path: target };
  }
  let pending = inflight.get(target);
  if (pending === undefined) {
    pending = limited(() => makeThumb(resolved.absolute, target, edge)).finally(() => {
      inflight.delete(target);
    });
    inflight.set(target, pending);
  }
  try {
    return { ok: true, path: await pending };
  } catch (thrown) {
    return { ok: false, error: thrown instanceof Error ? thrown.message : String(thrown) };
  }
}

/** protocol.handle 的处理函数。项目找不到、路径不在画板目录里，一律 404。 */
export function createCanvasImageHandler(deps: {
  readonly projectRootOf: (projectId: string) => Promise<string>;
  readonly cacheDir: string;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const parsed = parseCanvasImageUrl(request.url);
    if (parsed === undefined) {
      return new Response("bad canvas image url", { status: 400 });
    }
    let file: Awaited<ReturnType<typeof canvasImageFile>>;
    try {
      const root = await deps.projectRootOf(parsed.projectId);
      file = await canvasImageFile(root, parsed.relativePath, parsed.size, deps.cacheDir);
    } catch (thrown) {
      file = { ok: false, error: thrown instanceof Error ? thrown.message : String(thrown) };
    }
    if (!file.ok) {
      return new Response(file.error, { status: 404 });
    }
    const response = await net.fetch(pathToFileURL(file.path).toString());
    const headers = new Headers(response.headers);
    // 带标记预览要把原图画进 canvas 再导出，跨源要放行，否则 canvas 被污染导不出来。
    headers.set("access-control-allow-origin", "*");
    headers.set("cache-control", "no-cache");
    return new Response(response.body, { status: response.status, headers });
  };
}
