/**
 * 任务说明落盘（T10.7a）：只写 `<项目根>/.ffpane/briefs/`。
 * 拒绝穿越、绝对路径、设备名和符号链接逃逸。重名加序号，不覆盖。
 */

import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { hasControlChar } from "./remind";

export const BRIEF_MAX_BYTES = 256 * 1024;
export const BRIEFS_DIR_NAME = ".ffpane";

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function briefsDir(projectRoot: string): string {
  return join(resolve(projectRoot), ".ffpane", "briefs");
}

export function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isDevice(name: string): boolean {
  const stem = name.replace(/\..*$/, "");
  return DEVICE_NAME.test(stem);
}

/** 只接受 briefs 目录内的文件名。危险输入直接拒绝，不悄悄改写成别的名字。 */
export function normalizeBriefFileName(
  name: string,
):
  | { readonly ok: true; readonly fileName: string }
  | { readonly ok: false; readonly error: string } {
  if (typeof name !== "string") {
    return { ok: false, error: "文件名必须是字符串。" };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || hasControlChar(trimmed)) {
    return { ok: false, error: "文件名无效。" };
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    return { ok: false, error: "文件名不能包含路径或 .. 。请只写 briefs 目录里的文件名。" };
  }
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith("\\\\")) {
    return { ok: false, error: "不能使用绝对路径。" };
  }
  if (trimmed === "." || trimmed === "..") {
    return { ok: false, error: "文件名不能包含路径。" };
  }
  if (isDevice(trimmed)) {
    return { ok: false, error: `文件名 ${trimmed} 是设备名，不能使用。` };
  }
  const withExt = trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
  if (withExt.length > 80 || isDevice(withExt)) {
    return { ok: false, error: "文件名过长或不可用。" };
  }
  return { ok: true, fileName: withExt };
}

function withSuffix(fileName: string, n: number): string {
  if (n <= 1) {
    return fileName;
  }
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  return `${stem}-${n}${ext}`;
}

async function assertRealInside(root: string, target: string): Promise<boolean> {
  try {
    const real = await realpath(target);
    return isInsideRoot(root, real);
  } catch {
    return false;
  }
}

export async function writeBriefFile(input: {
  readonly projectRoot: string;
  readonly name: string;
  readonly content: string;
}): Promise<
  | { readonly ok: true; readonly relativePath: string; readonly absolutePath: string }
  | { readonly ok: false; readonly error: string }
> {
  const named = normalizeBriefFileName(input.name);
  if (!named.ok) {
    return named;
  }
  if (typeof input.content !== "string") {
    return { ok: false, error: "正文必须是字符串。" };
  }
  if (Buffer.byteLength(input.content, "utf8") > BRIEF_MAX_BYTES) {
    return { ok: false, error: "正文超过 256KB。请拆成多份说明。" };
  }
  const root = resolve(input.projectRoot);
  const dir = briefsDir(root);
  await mkdir(dir, { recursive: true });
  if (!(await assertRealInside(root, dir))) {
    return { ok: false, error: "briefs 目录经符号链接指向了项目之外，已拒绝写入。" };
  }
  const realDir = await realpath(dir);
  for (let n = 1; n <= 100; n += 1) {
    const fileName = withSuffix(named.fileName, n);
    if (isDevice(fileName)) {
      continue;
    }
    const full = join(realDir, fileName);
    let existing = false;
    try {
      const st = await lstat(full);
      existing = true;
      if (st.isSymbolicLink()) {
        continue;
      }
    } catch {
      existing = false;
    }
    if (existing) {
      continue;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(full, "wx");
      await handle.writeFile(input.content, "utf8");
    } catch {
      continue;
    } finally {
      await handle?.close();
    }
    if (!(await assertRealInside(realDir, full))) {
      return { ok: false, error: "写入结果越过了 briefs 目录，已拒绝。" };
    }
    const absolutePath = await realpath(full);
    return {
      ok: true,
      relativePath: `.ffpane/briefs/${fileName}`,
      absolutePath,
    };
  }
  return { ok: false, error: "briefs 目录里同名文件过多，无法分配新文件名。" };
}

/**
 * 近况页：只写 briefs 目录内的一个文件名。同名覆盖，不追加，不加序号。
 * 用 "w" 截断重写，不用 "a"。
 */
export async function writeStatusFile(input: {
  readonly projectRoot: string;
  readonly name: string;
  readonly content: string;
}): Promise<
  | { readonly ok: true; readonly relativePath: string; readonly absolutePath: string }
  | { readonly ok: false; readonly error: string }
> {
  const named = normalizeBriefFileName(input.name);
  if (!named.ok) {
    return named;
  }
  if (typeof input.content !== "string") {
    return { ok: false, error: "正文必须是字符串。" };
  }
  const normalized = input.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const body = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  if (body.trim().length === 0) {
    return { ok: false, error: "近况不能为空。" };
  }
  if (Buffer.byteLength(body, "utf8") > BRIEF_MAX_BYTES) {
    return { ok: false, error: "正文超过 256KB。请拆成多份说明。" };
  }
  const root = resolve(input.projectRoot);
  const dir = briefsDir(root);
  await mkdir(dir, { recursive: true });
  if (!(await assertRealInside(root, dir))) {
    return { ok: false, error: "briefs 目录经符号链接指向了项目之外，已拒绝写入。" };
  }
  const realDir = await realpath(dir);
  const full = join(realDir, named.fileName);
  try {
    const st = await lstat(full);
    if (st.isSymbolicLink() || !st.isFile()) {
      return { ok: false, error: "近况路径不是 briefs 目录里的普通文件，已拒绝覆盖。" };
    }
  } catch {
    // 还不存在，下面用 "w" 创建。
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(full, "w");
    await handle.writeFile(body, "utf8");
  } catch {
    return { ok: false, error: "写入近况失败。" };
  } finally {
    await handle?.close();
  }
  if (!(await assertRealInside(realDir, full))) {
    return { ok: false, error: "写入结果越过了 briefs 目录，已拒绝。" };
  }
  const absolutePath = await realpath(full);
  return {
    ok: true,
    relativePath: `.ffpane/briefs/${named.fileName}`,
    absolutePath,
  };
}

/** briefPath 必须落在该项目 .ffpane/briefs 内（相对或绝对均可）。 */
export async function resolveBriefPath(
  projectRoot: string,
  briefPath: string,
): Promise<
  | { readonly ok: true; readonly relativePath: string; readonly absolutePath: string }
  | { readonly ok: false; readonly error: string }
> {
  if (typeof briefPath !== "string" || briefPath.trim() === "" || hasControlChar(briefPath)) {
    return { ok: false, error: "briefPath 无效。" };
  }
  if (briefPath.includes("..")) {
    return { ok: false, error: "briefPath 不能包含 .. 。" };
  }
  const root = resolve(projectRoot);
  const dir = briefsDir(root);
  const absolute = resolve(root, briefPath);
  if (!isInsideRoot(dir, absolute)) {
    return { ok: false, error: "briefPath 必须位于该项目的 .ffpane/briefs/ 内。" };
  }
  if (!(await assertRealInside(root, dir))) {
    return { ok: false, error: "briefs 目录经符号链接指向了项目之外。" };
  }
  const realDir = await realpath(dir);
  let cursor = realDir;
  const rest = relative(realDir, absolute);
  if (rest.startsWith("..") || rest.includes(`..${sep}`)) {
    return { ok: false, error: "briefPath 必须位于该项目的 .ffpane/briefs/ 内。" };
  }
  for (const part of rest.split(sep).filter((item) => item.length > 0)) {
    if (isDevice(part)) {
      return { ok: false, error: "briefPath 含有设备名。" };
    }
    cursor = join(cursor, part);
    try {
      const st = await lstat(cursor);
      if (st.isSymbolicLink()) {
        const real = await realpath(cursor);
        if (!isInsideRoot(realDir, real)) {
          return { ok: false, error: "briefPath 经符号链接越过了 briefs 目录。" };
        }
      }
    } catch {
      break;
    }
  }
  const relativePath = `.ffpane/briefs/${rest.split(sep).join("/")}`;
  return { ok: true, relativePath, absolutePath: absolute };
}
