/**
 * 画板图片地址（T11.0d）：界面用 `<img src>` 直接取，主进程的 `ffpane-canvas://` 协议回文件。
 * 以前每张图都整张读成 base64 经 IPC 传进界面；6264 个缩略图同时请求，主进程一下子分配好几 GB。
 */

export const CANVAS_IMAGE_SCHEME = "ffpane-canvas";

/** thumb：长边 256 的缩略图；large：长边 1024（无限画布放大时用，T11.0c）；full：原图。 */
export type CanvasImageSize = "thumb" | "large" | "full";

export const CANVAS_THUMB_EDGE = 256;
export const CANVAS_LARGE_EDGE = 1024;

/** 每档缩略图的长边。 */
export function canvasImageEdge(size: Exclude<CanvasImageSize, "full">): number {
  return size === "large" ? CANVAS_LARGE_EDGE : CANVAS_THUMB_EDGE;
}

export interface CanvasImageRequest {
  readonly projectId: string;
  readonly relativePath: string;
  readonly size: CanvasImageSize;
}

/** version 只用来让同一路径换了图时浏览器重新取（画板里的 addedAt）。 */
export function canvasImageUrl(
  projectId: string,
  relativePath: string,
  size: CanvasImageSize,
  version?: string,
): string {
  const params = new URLSearchParams({ project: projectId, path: relativePath, size });
  if (version !== undefined && version !== "") {
    params.set("v", version);
  }
  return `${CANVAS_IMAGE_SCHEME}://image/?${params.toString()}`;
}

export function parseCanvasImageUrl(url: string): CanvasImageRequest | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${CANVAS_IMAGE_SCHEME}:` || parsed.hostname !== "image") {
    return undefined;
  }
  const projectId = parsed.searchParams.get("project") ?? "";
  const relativePath = parsed.searchParams.get("path") ?? "";
  const size = parsed.searchParams.get("size");
  if (
    projectId === "" ||
    relativePath === "" ||
    (size !== "thumb" && size !== "large" && size !== "full")
  ) {
    return undefined;
  }
  return { projectId, relativePath, size };
}
