/**
 * 工作台隐藏面板的只读文件访问。
 * 项目以 projectId 在调用方解析；这里只接受已经解析好的项目根。
 * 路径必须落在 `<项目根>/.ffpane/` 内，拒绝穿越、符号链接和 junction。
 */

import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { isSingleMarkdownFileName } from "../../shared/workbench/markdown-name";
import { isInsideRoot } from "./brief-files";
import { readThreadIndexText, type ThreadRecord } from "./thread-store";

export const PANEL_FILE_MAX_BYTES = 256 * 1024;
export const PANEL_INDEX_MAX_BYTES = 1024 * 1024;
export const PANEL_INDEX_PAGE_LIMIT = 40;

export interface BriefListItem {
  readonly name: string;
  readonly relativePath: string;
  readonly mtimeMs: number;
  readonly size: number;
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** 词法上把相对路径收进 `.ffpane`。不碰磁盘。 */
export function lexicalFfPanePath(
  projectRoot: string,
  relativePath: string,
):
  | { readonly ok: true; readonly absolute: string }
  | { readonly ok: false; readonly error: string } {
  if (typeof relativePath !== "string" || hasControl(relativePath)) {
    return { ok: false, error: "路径无效。" };
  }
  const trimmed = relativePath.trim().replace(/\\/g, "/");
  if (trimmed.length === 0) {
    return { ok: false, error: "路径无效。" };
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    /^[a-zA-Z]:/.test(trimmed) ||
    trimmed.includes("\0")
  ) {
    return { ok: false, error: "不能使用绝对路径。" };
  }
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    return { ok: false, error: "路径不能包含 .. 。" };
  }
  const rest = parts[0] === ".ffpane" ? parts.slice(1) : parts;
  if (rest.length === 0 || rest.some((part) => part === "." || part === "..")) {
    return { ok: false, error: "路径必须落在 .ffpane 内。" };
  }
  const ff = join(resolve(projectRoot), ".ffpane");
  const absolute = resolve(ff, ...rest);
  if (!isInsideRoot(ff, absolute)) {
    return { ok: false, error: "路径越过了 .ffpane。" };
  }
  return { ok: true, absolute };
}

async function realProjectRoot(projectRoot: string): Promise<string | undefined> {
  try {
    const stat = await lstat(resolve(projectRoot));
    if (stat.isSymbolicLink()) {
      return undefined;
    }
    return await realpath(resolve(projectRoot));
  } catch {
    return undefined;
  }
}

/**
 * 从真实项目根走到目标。路径上任一节是符号链接或 junction 都拒绝。
 * 目标必须真实存在，且 realpath 仍在 `<项目>/.ffpane` 内。
 */
export async function resolveFfPaneFile(
  projectRoot: string,
  relativePath: string,
): Promise<
  { readonly ok: true; readonly absolute: string } | { readonly ok: false; readonly error: string }
> {
  const lexical = lexicalFfPanePath(projectRoot, relativePath);
  if (!lexical.ok) {
    return lexical;
  }
  const root = await realProjectRoot(projectRoot);
  if (root === undefined) {
    return { ok: false, error: "项目根不可用。" };
  }
  const ffLexical = join(root, ".ffpane");
  const relFromRoot = relative(resolve(projectRoot), lexical.absolute);
  const segments = relFromRoot.split(sep).filter((part) => part.length > 0);
  if (segments.length === 0 || segments.some((part) => part === "." || part === "..")) {
    return { ok: false, error: "路径越过了 .ffpane。" };
  }
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(current);
    } catch {
      return { ok: false, error: "文件不存在。" };
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, error: "拒绝符号链接或 junction。" };
    }
  }
  let realFile: string;
  let realFf: string;
  try {
    realFile = await realpath(current);
    realFf = await realpath(ffLexical);
  } catch {
    return { ok: false, error: "无法确认路径仍在 .ffpane 内。" };
  }
  if (!isInsideRoot(root, realFf) || !isInsideRoot(realFf, realFile)) {
    return { ok: false, error: "路径越过了 .ffpane。" };
  }
  return { ok: true, absolute: realFile };
}

/** 打开前再确认：真实文件，且文件名是单个 .md。拒绝 .exe / .bat / .cmd / .lnk。 */
export async function assertOpenableMarkdown(
  absolutePath: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  if (!isSingleMarkdownFileName(basename(absolutePath))) {
    return { ok: false, error: "只能打开 Markdown 文件。" };
  }
  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, error: "只能打开 Markdown 文件。" };
    }
  } catch {
    return { ok: false, error: "文件不存在。" };
  }
  return { ok: true };
}

async function assertRealDirectory(
  projectRoot: string,
  absolute: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const rel = relative(resolve(projectRoot), absolute).split(sep).join("/");
  return resolveFfPaneFile(projectRoot, rel);
}

export async function listBriefFiles(
  projectRoot: string,
): Promise<
  | { readonly ok: true; readonly briefs: readonly BriefListItem[] }
  | { readonly ok: false; readonly error: string }
> {
  const root = await realProjectRoot(projectRoot);
  if (root === undefined) {
    return { ok: false, error: "项目根不可用。" };
  }
  const briefsDir = join(root, ".ffpane", "briefs");
  let dirStat: Awaited<ReturnType<typeof lstat>>;
  try {
    dirStat = await lstat(briefsDir);
  } catch {
    return { ok: true, briefs: [] };
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    return { ok: false, error: "briefs 目录经符号链接或 junction 指向了项目之外，已拒绝。" };
  }
  const checked = await assertRealDirectory(projectRoot, briefsDir);
  if (!checked.ok) {
    return checked;
  }
  const names = await readdir(briefsDir);
  const briefs: BriefListItem[] = [];
  for (const name of names) {
    if (
      !name.toLowerCase().endsWith(".md") ||
      name.includes("..") ||
      name.includes("/") ||
      name.includes("\\")
    ) {
      continue;
    }
    const full = join(briefsDir, name);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      continue;
    }
    const real = await resolveFfPaneFile(projectRoot, `.ffpane/briefs/${name}`);
    if (!real.ok) {
      continue;
    }
    briefs.push({
      name,
      relativePath: `.ffpane/briefs/${name}`,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }
  briefs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return { ok: true, briefs };
}

function utf8CharWidth(lead: number): number {
  if (lead < 0x80) {
    return 1;
  }
  if ((lead & 0xe0) === 0xc0) {
    return 2;
  }
  if ((lead & 0xf0) === 0xe0) {
    return 3;
  }
  if ((lead & 0xf8) === 0xf0) {
    return 4;
  }
  return 1;
}

/** 只解码已读入的前缀。文件更大时丢掉末尾未写完的 UTF-8 字符。 */
function decodeUtf8Prefix(
  buf: Buffer,
  fileLarger: boolean,
): { readonly text: string; readonly truncated: boolean } {
  if (!fileLarger) {
    return { text: buf.toString("utf8"), truncated: false };
  }
  let end = buf.length;
  let index = end - 1;
  let continuations = 0;
  while (index >= 0 && continuations < 3 && ((buf[index] ?? 0) & 0xc0) === 0x80) {
    continuations += 1;
    index -= 1;
  }
  if (index >= 0) {
    const width = utf8CharWidth(buf[index] ?? 0);
    if (width > continuations + 1) {
      end = index;
    }
  } else if (continuations > 0) {
    end = 0;
  }
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export async function readBriefFile(
  projectRoot: string,
  relativePath: string,
): Promise<
  | {
      readonly ok: true;
      readonly relativePath: string;
      readonly content: string;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly error: string }
> {
  const lexical = lexicalFfPanePath(projectRoot, relativePath);
  if (!lexical.ok) {
    return lexical;
  }
  const name = basename(lexical.absolute);
  if (!name.toLowerCase().endsWith(".md") || basename(lexical.absolute) !== name) {
    return { ok: false, error: "只能读取 briefs 目录里的 Markdown。" };
  }
  const parent = lexical.absolute.slice(0, lexical.absolute.length - name.length);
  const briefs = join(resolve(projectRoot), ".ffpane", "briefs") + sep;
  if (resolve(parent) !== resolve(briefs)) {
    return { ok: false, error: "只能读取 briefs 目录里的 Markdown。" };
  }
  const resolved = await resolveFfPaneFile(projectRoot, `.ffpane/briefs/${name}`);
  if (!resolved.ok) {
    return resolved;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(resolved.absolute, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { ok: false, error: "只能读取 briefs 目录里的 Markdown。" };
    }
    const readSize = Math.min(stat.size, PANEL_FILE_MAX_BYTES);
    const buf = Buffer.alloc(readSize);
    const { bytesRead } = readSize > 0 ? await handle.read(buf, 0, readSize, 0) : { bytesRead: 0 };
    const cut = decodeUtf8Prefix(buf.subarray(0, bytesRead), stat.size > PANEL_FILE_MAX_BYTES);
    return {
      ok: true,
      relativePath: `.ffpane/briefs/${name}`,
      content: cut.text,
      truncated: cut.truncated,
    };
  } catch {
    return { ok: false, error: "无法读取计划文件。" };
  } finally {
    await handle?.close();
  }
}

export async function readPanelThreadIndex(
  projectRoot: string,
): Promise<
  | { readonly ok: true; readonly records: readonly ThreadRecord[]; readonly capped: boolean }
  | { readonly ok: false; readonly error: string }
> {
  const resolved = await resolveFfPaneFile(projectRoot, ".ffpane/threads/index.jsonl");
  if (!resolved.ok) {
    if (resolved.error === "文件不存在。") {
      return { ok: true, records: [], capped: false };
    }
    return resolved;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(resolved.absolute, "r");
    const stat = await handle.stat();
    if (stat.size === 0) {
      return { ok: true, records: [], capped: false };
    }
    const capped = stat.size > PANEL_INDEX_MAX_BYTES;
    const readSize = Math.min(stat.size, PANEL_INDEX_MAX_BYTES);
    const start = stat.size - readSize;
    const buf = Buffer.alloc(readSize);
    await handle.read(buf, 0, readSize, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    return { ok: true, records: readThreadIndexText(text), capped };
  } catch {
    return { ok: false, error: "无法读取线程索引。" };
  } finally {
    await handle?.close();
  }
}

export function pageNewestFirst<T>(
  oldestFirst: readonly T[],
  offset: number,
  limit: number,
): { readonly page: readonly T[]; readonly hasMore: boolean } {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(PANEL_INDEX_PAGE_LIMIT, Math.floor(limit)))
    : PANEL_INDEX_PAGE_LIMIT;
  const newest = [...oldestFirst].reverse();
  return {
    page: newest.slice(safeOffset, safeOffset + safeLimit),
    hasMore: safeOffset + safeLimit < newest.length,
  };
}
