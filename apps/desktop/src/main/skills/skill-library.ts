/**
 * 技能库（T11.9 / 技能计划 §3）：FF-pane 自己数据目录里的一份技能，所有项目共用。
 *
 * - 目录：`<数据根>/skills/<原名>/`，信息：`<数据根>/skills.json`。不写 ~/.claude、~/.codex，不进项目。
 * - 导入是复制，不链接原目录；用户之后改原目录，各项目不会悄悄跟着变。
 * - 技能目录里的配置文件（`*.env`、`.env*`）由用户自己填。替换导入时旧的一份原样保留，不被新版本的模板盖掉。
 * - 本模块不读、不返回任何配置文件的内容。
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { writeJsonAtomic } from "@ff-pane/storage";
import type { SkillStatusWire, SkillView } from "../../shared-ipc/contracts";
import {
  detectSkillNeeds,
  guessSkillAuthor,
  isSkillAppliesTo,
  isValidSkillName,
  MAX_SKILL_NAME_LENGTH,
  parseSkillFrontmatter,
  type SkillAppliesTo,
  type SkillAuthorGuess,
  type SkillMountCandidate,
} from "./skill-manifest";

export interface SkillsLayout {
  /** 技能库目录，每个技能一个子目录。 */
  readonly libraryDir: string;
  /** 技能库信息（显示名、适用于、来源、导入时间）。 */
  readonly indexFile: string;
  /** 每个窗口挂载用的临时目录（Claude 插件目录），关窗即删。 */
  readonly mountsDir: string;
}

export function resolveSkillsLayout(globalRoot: string): SkillsLayout {
  return {
    libraryDir: join(globalRoot, "skills"),
    indexFile: join(globalRoot, "skills.json"),
    mountsDir: join(globalRoot, "skill-mounts"),
  };
}

export interface SkillIndexEntry {
  readonly name: string;
  readonly displayName?: string;
  readonly appliesTo: SkillAppliesTo;
  readonly author: SkillAuthorGuess;
  readonly source: string;
  readonly importedAt: number;
  readonly hash: string;
}

const SKILL_INDEX_VERSION = 1;

/** 导入失败。message 给人看，不含任何文件内容。 */
export class SkillImportError extends Error {
  readonly code:
    | "no-skill-md"
    | "multiple-skills"
    | "bad-frontmatter"
    | "bad-name"
    | "too-large"
    | "inside-library";

  constructor(code: SkillImportError["code"], message: string) {
    super(message);
    this.name = "SkillImportError";
    this.code = code;
  }
}

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`技能库里没有「${name}」。`);
    this.name = "SkillNotFoundError";
  }
}

/** 复制时跳过的目录。 */
const SKIPPED_DIRS = new Set([".git", "__pycache__", "node_modules", ".venv"]);
/** 导入上限，防止选错目录把整个盘拷进来。 */
export const MAX_SKILL_FILES = 2000;
export const MAX_SKILL_BYTES = 50 * 1024 * 1024;
/** 只看这么大以内的脚本文本（判断要不要联网工具）。 */
const MAX_SCANNED_TEXT_BYTES = 512 * 1024;

/** 用户自己填的配置文件：替换导入时保留旧的，不算进内容哈希。 */
export function isSkillConfigFile(relPath: string): boolean {
  const name = basename(relPath).toLowerCase();
  return name.endsWith(".env") || name === ".env" || name.startsWith(".env.");
}

interface WalkedFile {
  readonly rel: string;
  readonly abs: string;
  readonly size: number;
}

async function walkSkillDir(root: string): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  let total = 0;
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) {
          await visit(abs);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const size = (await stat(abs)).size;
      total += size;
      files.push({ rel: relative(root, abs).split(sep).join("/"), abs, size });
      if (files.length > MAX_SKILL_FILES || total > MAX_SKILL_BYTES) {
        throw new SkillImportError(
          "too-large",
          `这个目录太大（超过 ${MAX_SKILL_FILES} 个文件或 ${MAX_SKILL_BYTES / 1024 / 1024}MB），不像一个技能。请选技能自己的那个目录。`,
        );
      }
    }
  };
  await visit(root);
  return files;
}

interface InspectedSkill {
  readonly name: string;
  readonly description: string;
  readonly author: SkillAuthorGuess;
  readonly needsPython: boolean;
  readonly needsNode: boolean;
  readonly windowsHttps: boolean;
  readonly files: readonly WalkedFile[];
}

async function inspectSkillDir(dir: string): Promise<InspectedSkill> {
  const files = await walkSkillDir(dir);
  const skillMd = files.find((file) => file.rel === "SKILL.md");
  if (skillMd === undefined) {
    throw new SkillImportError("no-skill-md", "这个目录里没有 SKILL.md。");
  }
  const parsed = parseSkillFrontmatter(await readFile(skillMd.abs, "utf8"));
  if (!parsed.ok) {
    const what =
      parsed.reason === "no-frontmatter"
        ? "开头没有 --- 包起来的头部"
        : parsed.reason === "no-name"
          ? "头部缺 name"
          : "头部缺 description";
    throw new SkillImportError(
      "bad-frontmatter",
      `SKILL.md ${what}，Claude 和 Codex 都认不出这个技能。`,
    );
  }
  if (!isValidSkillName(parsed.name)) {
    throw new SkillImportError(
      "bad-name",
      `技能名「${parsed.name}」不合规：只能用小写字母、数字和连字符，最长 ${MAX_SKILL_NAME_LENGTH} 个字符。`,
    );
  }
  const scanned: { rel: string; text?: string }[] = [];
  for (const file of files) {
    if (isSkillConfigFile(file.rel)) {
      continue;
    }
    const isScript = /\.(py|js|mjs|cjs|ps1|sh|cmd|bat)$/i.test(file.rel);
    scanned.push(
      isScript && file.size <= MAX_SCANNED_TEXT_BYTES
        ? { rel: file.rel, text: await readFile(file.abs, "utf8") }
        : { rel: file.rel },
    );
  }
  const needs = detectSkillNeeds(scanned);
  return {
    name: parsed.name,
    description: parsed.description,
    author: guessSkillAuthor(
      files.map((file) => file.rel),
      parsed.keys,
    ),
    needsPython: needs.python,
    needsNode: needs.node,
    windowsHttps: needs.windowsHttps,
    files,
  };
}

/** 内容哈希：文件名和内容，不算配置文件。用来说「和上次一样」。 */
async function hashSkillFiles(files: readonly WalkedFile[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    if (isSkillConfigFile(file.rel)) {
      continue;
    }
    hash.update(file.rel);
    hash.update("\0");
    hash.update(await readFile(file.abs));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * 用户选的目录：本身有 SKILL.md 就是它；没有就看下一层，正好一个子目录有 SKILL.md 就用那个
 * （从 GitHub 下的仓库常是这样）。多个就让用户选具体那一个。
 */
export async function resolveImportSource(picked: string): Promise<string> {
  const root = resolve(picked);
  if (existsSync(join(root, "SKILL.md"))) {
    return root;
  }
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIRS.has(entry.name))
    .filter((entry) => existsSync(join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name);
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return join(root, candidates[0]);
  }
  if (candidates.length > 1) {
    throw new SkillImportError(
      "multiple-skills",
      `这个目录下有好几个技能（${candidates.join("、")}），请选其中一个目录导入。`,
    );
  }
  throw new SkillImportError("no-skill-md", "这个目录和它下一层都没有 SKILL.md。");
}

export async function readSkillIndex(layout: SkillsLayout): Promise<SkillIndexEntry[]> {
  let raw: string;
  try {
    raw = await readFile(layout.indexFile, "utf8");
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw) as { version?: unknown; skills?: unknown };
  if (parsed.version !== SKILL_INDEX_VERSION || !Array.isArray(parsed.skills)) {
    throw new Error(`skills.json 格式不对：${layout.indexFile}`);
  }
  const entries: SkillIndexEntry[] = [];
  for (const item of parsed.skills as Record<string, unknown>[]) {
    const name = typeof item["name"] === "string" ? item["name"] : "";
    if (!isValidSkillName(name)) {
      continue;
    }
    const displayName = typeof item["displayName"] === "string" ? item["displayName"].trim() : "";
    const author = item["author"];
    entries.push({
      name,
      ...(displayName !== "" ? { displayName } : {}),
      appliesTo: isSkillAppliesTo(item["appliesTo"]) ? item["appliesTo"] : "any",
      author: author === "codex" || author === "claude" ? author : "unknown",
      source: typeof item["source"] === "string" ? item["source"] : "",
      importedAt: typeof item["importedAt"] === "number" ? item["importedAt"] : 0,
      hash: typeof item["hash"] === "string" ? item["hash"] : "",
    });
  }
  return entries;
}

async function writeSkillIndex(
  layout: SkillsLayout,
  entries: readonly SkillIndexEntry[],
): Promise<void> {
  await writeJsonAtomic(layout.indexFile, {
    version: SKILL_INDEX_VERSION,
    skills: [...entries].sort((a, b) => a.name.localeCompare(b.name)),
  });
}

export interface ImportSkillOutcome {
  readonly status: "imported" | "replaced" | "exists";
  readonly name: string;
  readonly sameAsBefore?: boolean;
}

function isInside(child: string, parent: string): boolean {
  const norm = (path: string): string =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

/**
 * 导入一个技能（技能计划 §3.2）。同名已存在且没说替换时什么都不动，返回 exists。
 * 替换：先复制到旁边的临时目录，再换掉旧目录；旧目录里用户填的配置文件搬过去，不被新模板盖掉。
 */
export async function importSkill(
  layout: SkillsLayout,
  picked: string,
  options: { readonly replace?: boolean; readonly now?: number } = {},
): Promise<ImportSkillOutcome> {
  const sourceDir = await resolveImportSource(picked);
  if (isInside(sourceDir, layout.libraryDir)) {
    throw new SkillImportError("inside-library", "这个目录已经在技能库里了，不用再导入。");
  }
  const inspected = await inspectSkillDir(sourceDir);
  const entries = await readSkillIndex(layout);
  const existing = entries.find((entry) => entry.name === inspected.name);
  const target = join(layout.libraryDir, inspected.name);
  if ((existing !== undefined || existsSync(target)) && options.replace !== true) {
    return { status: "exists", name: inspected.name };
  }

  await mkdir(layout.libraryDir, { recursive: true });
  const tag = randomBytes(4).toString("hex");
  const staging = join(layout.libraryDir, `.staging-${inspected.name}-${tag}`);
  const trash = join(layout.libraryDir, `.trash-${inspected.name}-${tag}`);
  try {
    await cp(sourceDir, staging, {
      recursive: true,
      filter: (src) => !SKIPPED_DIRS.has(basename(src)),
    });
    if (existsSync(target)) {
      for (const file of await walkSkillDir(target)) {
        if (isSkillConfigFile(file.rel)) {
          const destination = join(staging, ...file.rel.split("/"));
          await mkdir(join(destination, ".."), { recursive: true });
          await cp(file.abs, destination, { force: true });
        }
      }
    }
    const hash = await hashSkillFiles(await walkSkillDir(staging));
    if (existsSync(target)) {
      await rename(target, trash);
    }
    await rename(staging, target);
    await rm(trash, { recursive: true, force: true });

    const next: SkillIndexEntry = {
      name: inspected.name,
      ...(existing?.displayName !== undefined ? { displayName: existing.displayName } : {}),
      appliesTo: existing?.appliesTo ?? "any",
      author: inspected.author,
      source: sourceDir,
      importedAt: options.now ?? Date.now(),
      hash,
    };
    await writeSkillIndex(layout, [
      ...entries.filter((entry) => entry.name !== inspected.name),
      next,
    ]);
    return existing !== undefined
      ? { status: "replaced", name: inspected.name, sameAsBefore: existing.hash === hash }
      : { status: "imported", name: inspected.name };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (!existsSync(target) && existsSync(trash)) {
      await rename(trash, target);
    }
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      throw new Error(
        "技能目录正被占用（可能有窗口正在跑它的脚本），等它跑完或关掉那个窗口再替换。",
      );
    }
    throw error;
  }
}

export interface SkillRuntimeProbe {
  readonly python: boolean;
  readonly node: boolean;
}

function commandWorks(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], {
      timeout: 5000,
      windowsHide: true,
      stdio: "ignore",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

let cachedProbe: { readonly at: number; readonly value: SkillRuntimeProbe } | undefined;

/** 本机有没有 python、node。结果缓存一分钟。 */
export function probeSkillRuntimes(now: number = Date.now()): SkillRuntimeProbe {
  if (cachedProbe !== undefined && now - cachedProbe.at < 60_000) {
    return cachedProbe.value;
  }
  const value = { python: commandWorks("python"), node: commandWorks("node") };
  cachedProbe = { at: now, value };
  return value;
}

/** 库里每个技能现在的样子。usedBy 由调用方按项目名单补。 */
export async function listSkills(
  layout: SkillsLayout,
  probe: SkillRuntimeProbe,
  usedBy: (name: string) => readonly string[] = () => [],
): Promise<SkillView[]> {
  const views: SkillView[] = [];
  for (const entry of await readSkillIndex(layout)) {
    const dir = join(layout.libraryDir, entry.name);
    let status: SkillStatusWire = "ok";
    let description = "";
    let needsPython = false;
    let needsNode = false;
    let windowsHttps = false;
    try {
      const inspected = await inspectSkillDir(dir);
      description = inspected.description;
      needsPython = inspected.needsPython;
      needsNode = inspected.needsNode;
      windowsHttps = inspected.windowsHttps;
      if (inspected.name !== entry.name) {
        status = "invalid";
      } else if (needsPython && !probe.python) {
        status = "python-missing";
      } else if (needsNode && !probe.node) {
        status = "node-missing";
      }
    } catch {
      status = "invalid";
    }
    views.push({
      name: entry.name,
      displayName: entry.displayName ?? "",
      description,
      appliesTo: entry.appliesTo,
      author: entry.author,
      status,
      needsPython,
      needsNode,
      windowsHttps,
      dir,
      source: entry.source,
      importedAt: entry.importedAt,
      usedBy: usedBy(entry.name),
    });
  }
  return views;
}

/** 挂载要用的那部分。 */
export function toMountCandidates(views: readonly SkillView[]): SkillMountCandidate[] {
  return views.map((view) => ({
    name: view.name,
    description: view.description,
    appliesTo: view.appliesTo,
    dir: view.dir,
    skillFile: join(view.dir, "SKILL.md"),
    ...(view.status !== "ok" ? { unavailable: view.status } : {}),
  }));
}

async function updateEntry(
  layout: SkillsLayout,
  name: string,
  patch: (entry: SkillIndexEntry) => SkillIndexEntry,
): Promise<void> {
  const entries = await readSkillIndex(layout);
  const found = entries.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new SkillNotFoundError(name);
  }
  await writeSkillIndex(
    layout,
    entries.map((entry) => (entry.name === name ? patch(entry) : entry)),
  );
}

/** 改显示名。空串恢复用原名。原名不变。 */
export async function setSkillDisplayName(
  layout: SkillsLayout,
  name: string,
  displayName: string,
): Promise<void> {
  const trimmed = displayName.trim().slice(0, 80);
  await updateEntry(layout, name, (entry) => {
    const { displayName: _old, ...rest } = entry;
    return trimmed === "" || trimmed === name ? rest : { ...rest, displayName: trimmed };
  });
}

export async function setSkillAppliesTo(
  layout: SkillsLayout,
  name: string,
  appliesTo: SkillAppliesTo,
): Promise<void> {
  await updateEntry(layout, name, (entry) => ({ ...entry, appliesTo }));
}

/** 从库里删掉：目录和信息都删。项目里的启用名单由调用方一起清。 */
export async function removeSkill(layout: SkillsLayout, name: string): Promise<void> {
  const entries = await readSkillIndex(layout);
  if (!entries.some((entry) => entry.name === name)) {
    throw new SkillNotFoundError(name);
  }
  if (!isValidSkillName(name)) {
    throw new SkillNotFoundError(name);
  }
  await rm(join(layout.libraryDir, name), { recursive: true, force: true });
  await writeSkillIndex(
    layout,
    entries.filter((entry) => entry.name !== name),
  );
}
